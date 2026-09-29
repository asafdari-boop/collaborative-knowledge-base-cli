import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeWorkspace, loadState, saveState, sha256 } from "../../src/index.js";

describe("state store", () => {
  it("round-trips versioned page state", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-state-"));
    await initializeWorkspace({ vault, dryRun: false });
    const state = await loadState(vault);
    state.pages["page:one"] = {
      pageId: "page:one",
      path: "Wiki/One.md",
      aliases: ["Wiki/Old One.md"],
      baseHash: sha256("base\n"),
      baseObjectHash: sha256("base\n"),
      sourceHashes: [sha256("source\n")],
      lastOperationId: "op:one",
    };

    await saveState(vault, state);

    expect((await loadState(vault)).pages["page:one"]).toEqual(state.pages["page:one"]);
  });

  it("round-trips stable Apple Notes source state", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-state-"));
    await initializeWorkspace({ vault, dryRun: false });
    const state = await loadState(vault);
    const noteIdHash = sha256("x-coredata://stable-note-id");
    state.sources[noteIdHash] = {
      sourceId: `apple-note:${noteIdHash}`,
      noteIdHash,
      path: `Sources/Apple Notes/apple-note-${noteIdHash.slice(0, 16)}.md`,
      title: "Renamed note",
      aliases: ["Original note"],
      account: "iCloud",
      folder: "Research",
      createdAt: "2025-01-01T00:00:00.000Z",
      modifiedAt: "2026-08-24T00:00:00.000Z",
      contentHash: sha256("body"),
      generatedHash: sha256("full source file"),
      attachmentHashes: [sha256("attachment")],
      censusStatus: "present",
      missingCensusCount: 0,
      lastSeenAt: "2026-08-24T00:01:00.000Z",
      lastOperationId: "op:one",
    };

    await saveState(vault, state);

    expect((await loadState(vault)).sources[noteIdHash]).toEqual(state.sources[noteIdHash]);
  });

  it("loads pre-pipeline state with an empty source registry", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-state-"));
    await initializeWorkspace({ vault, dryRun: false });
    const statePath = join(vault, ".ckb/state.json");
    await writeFile(statePath, '{"schemaVersion":1,"pages":{}}\n');

    const migrated = await loadState(vault);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.sources).toEqual({});
    expect(migrated.relationships).toEqual({});
  });

  it("rejects malformed or schema-invalid state", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-state-"));
    await initializeWorkspace({ vault, dryRun: false });
    const statePath = join(vault, ".ckb/state.json");

    await writeFile(statePath, "not json\n");
    await expect(loadState(vault)).rejects.toMatchObject({ code: "invalid_state" });

    await writeFile(statePath, '{"schemaVersion":99,"pages":{}}\n');
    await expect(loadState(vault)).rejects.toMatchObject({ code: "invalid_state" });
  });
});
