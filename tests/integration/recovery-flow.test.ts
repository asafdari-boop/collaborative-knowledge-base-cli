import { execFile } from "node:child_process";
import { access, appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  initializeWorkspace,
  appendJournal,
  listRecoveryRecords,
  newOperationId,
  readJournal,
  recoverWorkspace,
  sha256,
  loadState,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);

async function crashExitCode(script: string): Promise<number> {
  try {
    await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
    return 0;
  } catch (error: unknown) {
    return (error as { code: number }).code;
  }
}

describe("crash recovery", () => {
  it("clears a stale dead-process lock even when no recovery record exists", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-recovery-lock-"));
    await initializeWorkspace({ vault, dryRun: false });
    await writeFile(
      join(vault, ".ckb/lock"),
      `${JSON.stringify({
        pid: 2_147_483_647,
        acquiredAt: new Date().toISOString(),
        operationId: "op:00000000-0000-4000-8000-000000000001",
      })}\n`,
    );

    const result = await recoverWorkspace(vault);

    expect(result).toMatchObject({ recovered: [], staleLockCleared: true });
    await expect(access(join(vault, ".ckb/lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to clear a malformed lock whose ownership cannot be proven stale", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-recovery-lock-"));
    await initializeWorkspace({ vault, dryRun: false });
    await writeFile(join(vault, ".ckb/lock"), "not json\n");

    await expect(recoverWorkspace(vault)).rejects.toMatchObject({ code: "workspace_locked" });
    expect(await readFile(join(vault, ".ckb/lock"), "utf8")).toBe("not json\n");
  });

  it("ignores a truncated final journal record during recovery", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-recovery-journal-"));
    await initializeWorkspace({ vault, dryRun: false });
    await appendFile(join(vault, ".ckb/journal.jsonl"), '{"schemaVersion":1');

    expect(await readJournal(vault)).toEqual([]);

    const operationId = newOperationId();
    await appendJournal(vault, {
      schemaVersion: 1,
      operationId,
      actor: "test",
      timestamp: new Date().toISOString(),
      result: "recovered",
      conflictCount: 0,
      changes: [],
    });
    expect(await readJournal(vault)).toMatchObject([{ operationId, result: "recovered" }]);
  });

  it("restores a partially published vault after hard process termination", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-recovery-"));
    await initializeWorkspace({ vault, dryRun: false });
    await writeFile(join(vault, "Wiki/One.md"), "one old\n");
    await writeFile(join(vault, "Wiki/Two.md"), "two old\n");
    const moduleUrl = pathToFileURL(join(process.cwd(), "dist/index.js")).href;
    const childScript = `
      const ckb = await import(${JSON.stringify(moduleUrl)});
      const apply = ckb.createTransactionApplier({
        failureInjector(stage, index) {
          if (stage === "after_rename" && index === 0) process.exit(73);
        }
      });
      await apply({
        vault: ${JSON.stringify(vault)},
        actor: "crash-test",
        changes: [
          { path: "Wiki/One.md", expectedHash: ${JSON.stringify(sha256("one old\n"))}, content: "one new\\n" },
          { path: "Wiki/Two.md", expectedHash: ${JSON.stringify(sha256("two old\n"))}, content: "two new\\n" }
        ]
      });
    `;

    expect(await crashExitCode(childScript)).toBe(73);
    expect(await listRecoveryRecords(vault)).toHaveLength(1);
    expect(await readFile(join(vault, "Wiki/One.md"), "utf8")).toBe("one new\n");
    expect(await readFile(join(vault, "Wiki/Two.md"), "utf8")).toBe("two old\n");

    const recovered = await recoverWorkspace(vault);

    expect(recovered.recovered).toHaveLength(1);
    expect(recovered.staleLockCleared).toBe(true);
    expect(await readFile(join(vault, "Wiki/One.md"), "utf8")).toBe("one old\n");
    expect(await readFile(join(vault, "Wiki/Two.md"), "utf8")).toBe("two old\n");
    expect(await listRecoveryRecords(vault)).toEqual([]);
    expect((await readJournal(vault)).map((event) => event.result)).toEqual([
      "prepared",
      "recovered",
    ]);
    await expect(access(join(vault, ".ckb/lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores both files and state after termination following the state swap", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-recovery-state-"));
    await initializeWorkspace({ vault, dryRun: false });
    await writeFile(join(vault, "Wiki/Page.md"), "old\n");
    const stateHash = sha256(await readFile(join(vault, ".ckb/state.json"), "utf8"));
    const moduleUrl = pathToFileURL(join(process.cwd(), "dist/index.js")).href;
    const childScript = `
      const ckb = await import(${JSON.stringify(moduleUrl)});
      const state = await ckb.loadState(${JSON.stringify(vault)});
      state.pages["page:crash"] = {
        pageId: "page:crash",
        path: "Wiki/Page.md",
        aliases: [],
        sourceHashes: []
      };
      const apply = ckb.createTransactionApplier({
        failureInjector(stage) {
          if (stage === "after_state_save") process.exit(74);
        }
      });
      await apply({
        vault: ${JSON.stringify(vault)},
        actor: "crash-state-test",
        changes: [
          { path: "Wiki/Page.md", expectedHash: ${JSON.stringify(sha256("old\n"))}, content: "new\\n" }
        ],
        nextState: state,
        expectedStateHash: ${JSON.stringify(stateHash)}
      });
    `;

    expect(await crashExitCode(childScript)).toBe(74);
    expect(await readFile(join(vault, "Wiki/Page.md"), "utf8")).toBe("new\n");
    expect((await loadState(vault)).pages["page:crash"]).toBeDefined();

    await recoverWorkspace(vault);

    expect(await readFile(join(vault, "Wiki/Page.md"), "utf8")).toBe("old\n");
    expect((await loadState(vault)).pages["page:crash"]).toBeUndefined();
  });
});
