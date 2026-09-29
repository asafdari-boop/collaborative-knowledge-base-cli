import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CkbConfigSchema,
  FixtureNotesExtractor,
  UpstreamDiffService,
  classifyUpstreamChanges,
  initializeWorkspace,
  refreshSourceMirror,
  sha256,
  type CkbConfig,
  type ExtractionOptions,
  type ExtractionResult,
  type NotesExtractor,
  type SourceState,
  type WorkspaceState,
} from "../../src/index.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/apple-notes");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

function source(
  key: string,
  overrides: Partial<SourceState> = {},
): SourceState {
  return {
    sourceId: `apple-note:${key.padEnd(64, "0")}`,
    noteIdHash: key.padEnd(64, "0"),
    path: `Notes/${key}.md`,
    title: key,
    aliases: [],
    account: "iCloud",
    folder: "Notes",
    createdAt: "2025-01-01T00:00:00.000Z",
    modifiedAt: "2025-01-01T00:00:00.000Z",
    ingestedAt: "2025-01-01T00:00:01.000Z",
    contentHash: HASH_A,
    generatedHash: HASH_B,
    attachmentHashes: [],
    censusStatus: "present",
    missingCensusCount: 0,
    lastSeenAt: "2025-01-01T00:00:01.000Z",
    upstreamHash: HASH_A,
    upstreamRegionHash: HASH_A,
    connectionsRegionHash: HASH_C,
    localRegionHash: HASH_D,
    syncStatus: "clean",
    secondaryMocs: [],
    pathHistory: [],
    ...overrides,
  };
}

function state(sources: Record<string, SourceState>): WorkspaceState {
  return {
    schemaVersion: 2,
    pages: {},
    sources,
    relationships: {},
    unresolvedReferences: {},
    wikiSynthesis: {},
  };
}

async function vaultSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const key = relative(root, path).split(sep).join("/");
        snapshot[key] = sha256(await readFile(path));
      }
    }
  };
  await visit(root);
  return Object.fromEntries(Object.entries(snapshot).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

async function publishedFixture(): Promise<{
  vault: string;
  config: CkbConfig;
  fixture: FixtureNotesExtractor;
}> {
  const vault = await mkdtemp(join(tmpdir(), "ckb-upstream-diff-vault-"));
  await initializeWorkspace({ vault, dryRun: false });
  const config = CkbConfigSchema.parse({ schemaVersion: 1, vaultPath: vault });
  const fixture = new FixtureNotesExtractor(fixtureRoot);
  const stagingDirectory = await mkdtemp(join(tmpdir(), "ckb-upstream-baseline-"));
  try {
    const extraction = await fixture.extract({
      stagingDirectory,
      accountAllowlist: config.extractor.accountAllowlist,
      folderAllowlist: config.extractor.folderAllowlist,
      noteIdAllowlist: config.extractor.noteIdAllowlist,
      maximumNoteCount: config.extractor.maximumNoteCount,
      timeoutMs: config.extractor.timeoutMs,
    });
    await refreshSourceMirror({ vault, extraction, config });
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
  return { vault, config, fixture };
}

function capturingExtractor(
  delegate: NotesExtractor,
  capture: (directory: string) => void,
): NotesExtractor {
  return {
    async extract(options: ExtractionOptions): Promise<ExtractionResult> {
      capture(options.stagingDirectory);
      return delegate.extract(options);
    },
  };
}

describe("upstream Apple Notes change classification", () => {
  it("classifies new, changed, missing, and unchanged sources by stable identity", () => {
    const previous = state({
      a: source("a", { title: "Bravo", contentHash: HASH_A }),
      b: source("b", { title: "Charlie", contentHash: HASH_B }),
      c: source("c", { title: "Alpha", contentHash: HASH_C }),
    });
    const proposed = state({
      a: source("a", { title: "Bravo", contentHash: HASH_D }),
      b: source("b", {
        title: "Charlie",
        contentHash: HASH_B,
        censusStatus: "missing_upstream",
      }),
      c: source("c", { title: "Alpha", contentHash: HASH_C }),
      d: source("d", { title: "Delta", contentHash: HASH_E }),
    });

    expect(classifyUpstreamChanges(previous, proposed)).toEqual({
      summary: { new: 1, changed: 1, missing: 1, unchanged: 1 },
      changes: [
        {
          kind: "changed",
          sourceId: proposed.sources.a!.sourceId,
          title: "Bravo",
          path: "Notes/a.md",
          changedFields: ["content"],
          previousContentHash: HASH_A,
          currentContentHash: HASH_D,
        },
        {
          kind: "missing",
          sourceId: proposed.sources.b!.sourceId,
          title: "Charlie",
          path: "Notes/b.md",
          changedFields: ["status"],
          previousContentHash: HASH_B,
          currentContentHash: null,
        },
        {
          kind: "new",
          sourceId: proposed.sources.d!.sourceId,
          title: "Delta",
          path: "Notes/d.md",
          changedFields: [],
          previousContentHash: null,
          currentContentHash: HASH_E,
        },
      ],
    });
  });

  it("reports every upstream-owned field in a stable order", () => {
    const previous = source("a", {
      attachmentHashes: [HASH_A],
      contentHash: HASH_A,
    });
    const proposed = source("a", {
      attachmentHashes: [HASH_B],
      contentHash: HASH_B,
      title: "Renamed",
      account: "On My Mac",
      folder: "Archive",
      createdAt: "2024-12-31T00:00:00.000Z",
      modifiedAt: "2025-01-02T00:00:00.000Z",
      censusStatus: "excluded",
      path: "Notes/Renamed.md",
    });

    const result = classifyUpstreamChanges(state({ a: previous }), state({ a: proposed }));

    expect(result.changes).toEqual([
      expect.objectContaining({
        kind: "changed",
        sourceId: previous.sourceId,
        title: "Renamed",
        path: "Notes/Renamed.md",
        changedFields: [
          "content",
          "attachments",
          "title",
          "account",
          "folder",
          "createdAt",
          "modifiedAt",
          "status",
        ],
      }),
    ]);
  });

  it("treats attachment hashes as a set", () => {
    const previous = source("a", { attachmentHashes: [HASH_A, HASH_B] });
    const proposed = source("a", { attachmentHashes: [HASH_B, HASH_A] });

    expect(classifyUpstreamChanges(state({ a: previous }), state({ a: proposed }))).toEqual({
      summary: { new: 0, changed: 0, missing: 0, unchanged: 1 },
      changes: [],
    });
  });

  it("ignores generated graph, local, ingestion, and path bookkeeping fields", () => {
    const previous = source("a");
    const proposed = source("a", {
      path: "Notes/Generated bookkeeping move.md",
      ingestedAt: "2026-01-01T00:00:00.000Z",
      generatedHash: HASH_E,
      upstreamHash: HASH_E,
      upstreamRegionHash: HASH_E,
      connectionsRegionHash: HASH_E,
      localRegionHash: HASH_E,
      primaryMoc: "frameworks-and-mental-models",
      secondaryMocs: ["books-and-learning"],
      syncStatus: "local_divergence",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      lastOperationId: "op:ignored",
      pathHistory: ["Notes/a.md"],
    });

    expect(classifyUpstreamChanges(state({ a: previous }), state({ a: proposed }))).toEqual({
      summary: { new: 0, changed: 0, missing: 0, unchanged: 1 },
      changes: [],
    });
  });

  it("keeps duplicate titles separate using their source map keys", () => {
    const first = source("a", { title: "New Note", path: "Notes/New Note — Notes — a.md" });
    const second = source("b", { title: "New Note", path: "Notes/New Note — Notes — b.md" });

    const result = classifyUpstreamChanges(
      state({ a: first }),
      state({ a: first, b: second }),
    );

    expect(result.summary).toEqual({ new: 1, changed: 0, missing: 0, unchanged: 1 });
    expect(result.changes).toEqual([
      expect.objectContaining({
        kind: "new",
        sourceId: second.sourceId,
        path: second.path,
      }),
    ]);
  });

  it("does not re-report a source that was already missing in the saved state", () => {
    const missing = source("a", { censusStatus: "missing_upstream" });

    expect(classifyUpstreamChanges(state({ a: missing }), state({ a: missing }))).toEqual({
      summary: { new: 0, changed: 0, missing: 0, unchanged: 1 },
      changes: [],
    });
  });
});

describe("upstream Apple Notes diff service", () => {
  it("reports an unchanged fixture without changing any vault byte", async () => {
    const { vault, config, fixture } = await publishedFixture();
    const before = await vaultSnapshot(vault);
    let stagingDirectory = "";
    const service = new UpstreamDiffService({
      extractor: capturingExtractor(fixture, (path) => {
        stagingDirectory = path;
      }),
    });

    const result = await service.diff({ vault, config });

    expect(result).toEqual({
      capturedAt: "2026-08-24T00:00:01.000Z",
      source: { mode: "live" },
      summary: { new: 0, changed: 0, missing: 0, unchanged: 7 },
      changes: [],
      warnings: [
        {
          code: "inaccessible_note",
          message: "One synthetic note is inaccessible.",
        },
      ],
    });
    expect(await vaultSnapshot(vault)).toEqual(before);
    await expect(access(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discloses when the configured upstream is a copied database", async () => {
    const { vault, config, fixture } = await publishedFixture();
    const copiedConfig: CkbConfig = {
      ...config,
      extractor: {
        ...config.extractor,
        databasePath: "/tmp/copied-apple-notes/NoteStore.sqlite",
      },
    };

    const result = await new UpstreamDiffService({ extractor: fixture }).diff({
      vault,
      config: copiedConfig,
    });

    expect(result.source).toEqual({ mode: "copied-database" });
  });

  it("fails closed on an incomplete census and removes temporary extraction", async () => {
    const { vault, config } = await publishedFixture();
    const before = await vaultSnapshot(vault);
    let stagingDirectory = "";
    const incomplete = new FixtureNotesExtractor(fixtureRoot, { complete: false });
    const service = new UpstreamDiffService({
      extractor: capturingExtractor(incomplete, (path) => {
        stagingDirectory = path;
      }),
    });

    await expect(service.diff({ vault, config })).rejects.toMatchObject({
      code: "incomplete_census",
    });
    expect(await vaultSnapshot(vault)).toEqual(before);
    await expect(access(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes temporary extraction when the exporter fails", async () => {
    const { vault, config } = await publishedFixture();
    const before = await vaultSnapshot(vault);
    let stagingDirectory = "";
    const failure = new Error("synthetic exporter failure");
    const failing = new FixtureNotesExtractor(fixtureRoot, { failWith: failure });
    const service = new UpstreamDiffService({
      extractor: capturingExtractor(failing, (path) => {
        stagingDirectory = path;
      }),
    });

    await expect(service.diff({ vault, config })).rejects.toBe(failure);
    expect(await vaultSnapshot(vault)).toEqual(before);
    await expect(access(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
