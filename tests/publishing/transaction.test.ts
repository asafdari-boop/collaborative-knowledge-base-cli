import {
  access,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyTransaction,
  createTransactionApplier,
  getObject,
  initializeWorkspace,
  loadState,
  newOperationId,
  recoverWorkspace,
  sha256,
  listRecoveryRecords,
} from "../../src/index.js";

async function journal(vault: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(vault, ".ckb/journal.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("transaction", () => {
  it("atomically installs review records and immutable objects with live changes", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const object = "shared revision\n";

    await applyTransaction({
      vault,
      actor: "test",
      changes: [{ path: "Wiki/New.md", expectedHash: null, content: "new\n" }],
      internalChanges: [
        {
          path: ".ckb/reviews/00000000-0000-4000-8000-000000000001.json",
          expectedHash: null,
          content: "{}\n",
        },
      ],
      objects: [object],
    });

    expect(await readFile(join(vault, "Wiki/New.md"), "utf8")).toBe("new\n");
    expect(
      await readFile(
        join(vault, ".ckb/reviews/00000000-0000-4000-8000-000000000001.json"),
        "utf8",
      ),
    ).toBe("{}\n");
    expect(await getObject(vault, sha256(object))).toBe(object);
  });

  it("applies expected-hash writes and journals their hashes", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const target = join(vault, "Wiki/Page.md");
    await writeFile(target, "old\n");

    const result = await applyTransaction({
      vault,
      actor: "test",
      changes: [
        { path: "Wiki/Page.md", expectedHash: sha256("old\n"), content: "new\n" },
      ],
    });

    expect(result.result).toBe("applied");
    expect(await readFile(target, "utf8")).toBe("new\n");
    expect(await journal(vault)).toMatchObject([
      { result: "prepared", actor: "test" },
      {
        result: "applied",
        actor: "test",
        changes: [
          {
            path: "Wiki/Page.md",
            previousHash: sha256("old\n"),
            newHash: sha256("new\n"),
          },
        ],
      },
    ]);
  });

  it("keeps a committed publish applied when post-commit cleanup is interrupted", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const target = join(vault, "Wiki/Page.md");
    await writeFile(target, "old\n");
    const guardedApply = createTransactionApplier({
      failureInjector(stage) {
        if (stage === "after_commit") throw new Error("cleanup interrupted");
      },
    });

    await expect(
      guardedApply({
        vault,
        actor: "test",
        changes: [
          { path: "Wiki/Page.md", expectedHash: sha256("old\n"), content: "new\n" },
        ],
      }),
    ).resolves.toMatchObject({ result: "applied" });

    expect(await readFile(target, "utf8")).toBe("new\n");
    expect(await listRecoveryRecords(vault)).toHaveLength(1);

    const recovered = await recoverWorkspace(vault);
    expect(recovered.completedCleanup).toHaveLength(1);
    expect(recovered.recovered).toEqual([]);
    expect(await readFile(target, "utf8")).toBe("new\n");
    expect(await listRecoveryRecords(vault)).toEqual([]);
  });

  it("rejects a stale hash before changing any target", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const target = join(vault, "Wiki/Page.md");
    await writeFile(target, "human edit\n");

    await expect(
      applyTransaction({
        vault,
        actor: "test",
        changes: [
          { path: "Wiki/Page.md", expectedHash: sha256("older\n"), content: "agent\n" },
        ],
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });

    expect(await readFile(target, "utf8")).toBe("human edit\n");
    expect(await journal(vault)).toEqual([]);
  });

  it("preserves an Obsidian edit that lands after validation but before replacement", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const target = join(vault, "Wiki/Page.md");
    await writeFile(target, "old\n");
    const guardedApply = createTransactionApplier({
      failureInjector(stage, index) {
        if (stage === "before_replace" && index === 0) {
          writeFileSync(target, "late Obsidian edit\n");
        }
      },
    });

    await expect(
      guardedApply({
        vault,
        actor: "test",
        changes: [
          { path: "Wiki/Page.md", expectedHash: sha256("old\n"), content: "agent\n" },
        ],
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });

    expect(await readFile(target, "utf8")).toBe("late Obsidian edit\n");
  });

  it("does not overwrite a page recreated after displacement", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const target = join(vault, "Wiki/Page.md");
    await writeFile(target, "old\n");
    const guardedApply = createTransactionApplier({
      failureInjector(stage, index) {
        if (stage === "after_displace" && index === 0) {
          writeFileSync(target, "recreated Obsidian edit\n");
        }
      },
    });

    await expect(
      guardedApply({
        vault,
        actor: "test",
        changes: [
          { path: "Wiki/Page.md", expectedHash: sha256("old\n"), content: "agent\n" },
        ],
      }),
    ).rejects.toMatchObject({ code: "rollback_failed" });

    expect(await readFile(target, "utf8")).toBe("recreated Obsidian edit\n");
    expect(await listRecoveryRecords(vault)).toHaveLength(1);
  });

  it("rejects path traversal and symlink traversal", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    const outside = await mkdtemp(join(tmpdir(), "ckb-outside-"));
    await initializeWorkspace({ vault, dryRun: false });
    await symlink(outside, join(vault, "Wiki/linked"));

    await expect(
      applyTransaction({
        vault,
        actor: "test",
        changes: [{ path: "../outside.md", expectedHash: null, content: "escape\n" }],
      }),
    ).rejects.toMatchObject({ code: "path_escape" });
    await expect(
      applyTransaction({
        vault,
        actor: "test",
        changes: [
          { path: "Wiki/linked/escape.md", expectedHash: null, content: "escape\n" },
        ],
      }),
    ).rejects.toMatchObject({ code: "symlink_path" });
    await expect(
      applyTransaction({
        vault,
        actor: "test",
        changes: [
          { path: "Wiki/../.ckb/state.json", expectedHash: null, content: "overwrite\n" },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_transaction" });
    await expect(access(join(outside, "escape.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back every target after a partial publish failure", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    await writeFile(join(vault, "Wiki/One.md"), "one old\n");
    await writeFile(join(vault, "Wiki/Two.md"), "two old\n");
    const failingApply = createTransactionApplier({
      failureInjector(stage, index) {
        if (stage === "after_rename" && index === 0) throw new Error("injected failure");
      },
    });

    await expect(
      failingApply({
        vault,
        actor: "test",
        changes: [
          {
            path: "Wiki/One.md",
            expectedHash: sha256("one old\n"),
            content: "one new\n",
          },
          {
            path: "Wiki/Two.md",
            expectedHash: sha256("two old\n"),
            content: "two new\n",
          },
        ],
      }),
    ).rejects.toThrow("injected failure");

    expect(await readFile(join(vault, "Wiki/One.md"), "utf8")).toBe("one old\n");
    expect(await readFile(join(vault, "Wiki/Two.md"), "utf8")).toBe("two old\n");
    expect((await journal(vault)).map((event) => event.result)).toEqual([
      "prepared",
      "rolled_back",
    ]);
    await expect(access(join(vault, ".ckb/lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes and rolls back binary attachment bytes without UTF-8 conversion", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const original = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    const replacement = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await writeFile(join(vault, "Attachments/one.bin"), original);
    const failingApply = createTransactionApplier({
      failureInjector(stage, index) {
        if (stage === "after_rename" && index === 0) throw new Error("binary failure");
      },
    });

    await expect(
      failingApply({
        vault,
        actor: "test",
        changes: [
          {
            path: "Attachments/one.bin",
            expectedHash: sha256(original),
            content: replacement,
          },
          {
            path: "Attachments/two.bin",
            expectedHash: null,
            content: Buffer.from([0x01, 0x02]),
          },
        ],
      }),
    ).rejects.toThrow("binary failure");

    expect(await readFile(join(vault, "Attachments/one.bin"))).toEqual(original);
    await expect(access(join(vault, "Attachments/two.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("supports safe creates and deletes", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });

    await applyTransaction({
      vault,
      actor: "test",
      changes: [{ path: "Reviews/New.md", expectedHash: null, content: "review\n" }],
    });
    await applyTransaction({
      vault,
      actor: "test",
      changes: [
        {
          path: "Reviews/New.md",
          expectedHash: sha256("review\n"),
          content: null,
        },
      ],
    });

    await expect(access(join(vault, "Reviews/New.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically records a state-only operation with a caller-supplied ID", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const state = await loadState(vault);
    const expectedStateHash = sha256(await readFile(join(vault, ".ckb/state.json"), "utf8"));
    state.pages["page:one"] = {
      pageId: "page:one",
      path: "Wiki/One.md",
      aliases: [],
      sourceHashes: [],
    };
    const operationId = newOperationId();

    const result = await applyTransaction({
      vault,
      actor: "test",
      operationId,
      changes: [],
      nextState: state,
      expectedStateHash,
    });

    expect(result.operationId).toBe(operationId);
    expect((await loadState(vault)).pages["page:one"]?.path).toBe("Wiki/One.md");
    expect(await journal(vault)).toMatchObject([
      { operationId, result: "prepared", changes: [] },
      { operationId, result: "applied", changes: [] },
    ]);
  });

  it("rejects reuse of an operation ID already present in the durable journal", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const operationId = newOperationId();
    await applyTransaction({
      vault,
      actor: "first",
      operationId,
      changes: [{ path: "Wiki/First.md", expectedHash: null, content: "first\n" }],
    });

    await expect(
      applyTransaction({
        vault,
        actor: "second",
        operationId,
        changes: [{ path: "Wiki/Second.md", expectedHash: null, content: "second\n" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_transaction" });

    await expect(access(join(vault, "Wiki/Second.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates safe nested parent folders for a new page", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });

    await applyTransaction({
      vault,
      actor: "test",
      changes: [
        {
          path: "Wiki/Frameworks/Mental Models.md",
          expectedHash: null,
          content: "# Mental Models\n",
        },
      ],
    });

    expect(await readFile(join(vault, "Wiki/Frameworks/Mental Models.md"), "utf8")).toBe(
      "# Mental Models\n",
    );
  });

  it("removes newly-created empty folders when publication rolls back", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const failingApply = createTransactionApplier({
      failureInjector(stage, index) {
        if (stage === "after_rename" && index === 0) throw new Error("nested failure");
      },
    });

    await expect(
      failingApply({
        vault,
        actor: "test",
        changes: [
          {
            path: "Wiki/New Area/Page.md",
            expectedHash: null,
            content: "new\n",
          },
        ],
      }),
    ).rejects.toThrow("nested failure");

    await expect(access(join(vault, "Wiki/New Area"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stale state snapshot instead of overwriting newer page state", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const expectedStateHash = sha256(await readFile(join(vault, ".ckb/state.json"), "utf8"));
    const firstState = await loadState(vault);
    const delayedState = await loadState(vault);
    firstState.pages["page:first"] = {
      pageId: "page:first",
      path: "Wiki/First.md",
      aliases: [],
      sourceHashes: [],
    };
    delayedState.pages["page:delayed"] = {
      pageId: "page:delayed",
      path: "Wiki/Delayed.md",
      aliases: [],
      sourceHashes: [],
    };

    await applyTransaction({
      vault,
      actor: "first",
      expectedStateHash,
      changes: [],
      nextState: firstState,
    });
    await expect(
      applyTransaction({
        vault,
        actor: "delayed",
        expectedStateHash,
        changes: [],
        nextState: delayedState,
      }),
    ).rejects.toMatchObject({ code: "stale_state" });

    const finalState = await loadState(vault);
    expect(finalState.pages["page:first"]?.path).toBe("Wiki/First.md");
    expect(finalState.pages["page:delayed"]).toBeUndefined();
  });

  it("uses an unchanged file as a lock-time assertion without rewriting it", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const target = join(vault, "Wiki/Page.md");
    await writeFile(target, "unchanged\n");
    const before = await stat(target);
    const state = await loadState(vault);
    const expectedStateHash = sha256(await readFile(join(vault, ".ckb/state.json"), "utf8"));

    const result = await applyTransaction({
      vault,
      actor: "assertion",
      changes: [
        {
          path: "Wiki/Page.md",
          expectedHash: sha256("unchanged\n"),
          content: "unchanged\n",
        },
      ],
      nextState: state,
      expectedStateHash,
    });

    expect(result.changes).toEqual([]);
    expect((await stat(target)).ino).toBe(before.ino);
  });

  it("rejects expectedStateHash when no state update is supplied", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-tx-"));
    await initializeWorkspace({ vault, dryRun: false });
    const target = join(vault, "Wiki/Page.md");
    await writeFile(target, "old\n");

    await expect(
      applyTransaction({
        vault,
        actor: "mistaken-caller",
        expectedStateHash: sha256(await readFile(join(vault, ".ckb/state.json"), "utf8")),
        changes: [
          { path: "Wiki/Page.md", expectedHash: sha256("old\n"), content: "new\n" },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_transaction" });
    expect(await readFile(target, "utf8")).toBe("old\n");
  });
});
