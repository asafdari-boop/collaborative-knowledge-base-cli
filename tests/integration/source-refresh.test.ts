import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CkbConfigSchema,
  FixtureNotesExtractor,
  createTransactionApplier,
  initializeWorkspace,
  loadState,
  planSourceMirrorRefresh,
  refreshSourceMirror,
  sha256,
} from "../../src/index.js";
import type { ExtractionResult } from "../../src/index.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/apple-notes");

async function setup() {
  const vault = await mkdtemp(join(tmpdir(), "ckb-source-vault-"));
  await initializeWorkspace({ vault, dryRun: false });
  const extractor = new FixtureNotesExtractor(fixtureRoot);
  const config = CkbConfigSchema.parse({ schemaVersion: 1, vaultPath: vault });
  const extract = async (): Promise<ExtractionResult> =>
    extractor.extract({
      stagingDirectory: await mkdtemp(join(tmpdir(), "ckb-source-stage-")),
      accountAllowlist: [],
      folderAllowlist: [],
      timeoutMs: 1_000,
    });
  return { vault, config, extract };
}

describe("source mirror refresh", () => {
  it("can plan the complete source refresh without writing live or internal files", async () => {
    const { vault, config, extract } = await setup();

    const plan = await planSourceMirrorRefresh({
      vault,
      extraction: await extract(),
      config,
    });

    expect(plan.result).toMatchObject({ created: 7, attachmentFilesCreated: 1 });
    expect(plan.sources.filter((source) => source.compilerEligible)).toHaveLength(5);
    expect(Object.keys((await loadState(vault)).sources)).toHaveLength(0);
    expect(await readdir(join(vault, "Sources/Apple Notes"))).toEqual([]);
    expect(await readdir(join(vault, "Attachments"))).toEqual([]);
    expect(await readdir(join(vault, ".ckb/objects"))).toEqual([]);
  });

  it("publishes stable source files and binary attachments atomically", async () => {
    const { vault, config, extract } = await setup();

    const result = await refreshSourceMirror({
      vault,
      extraction: await extract(),
      config,
    });
    const state = await loadState(vault);

    expect(result).toMatchObject({
      created: 7,
      updated: 0,
      attachmentFilesCreated: 1,
      excluded: 1,
      inaccessible: 1,
      missing: 0,
    });
    expect(Object.keys(state.sources)).toHaveLength(7);
    const framework = Object.values(state.sources).find((entry) => entry.title === "Frameworks");
    expect(framework).toBeDefined();
    const frameworkContent = await readFile(join(vault, framework?.path ?? ""), "utf8");
    expect(sha256(frameworkContent)).toBe(framework?.generatedHash);
    expect(frameworkContent).toContain("[[Notes/Example Thinker|Example Thinker]]");
    expect(frameworkContent).toContain("- Related: [[Notes/Example Thinker|Example Thinker]]");
    expect(Object.values(state.relationships)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromId: framework?.sourceId,
        kind: "related",
        origin: "explicit",
      }),
    ]));

    const evidence = Object.values(state.sources).find((entry) => entry.title === "Evidence");
    const evidenceContent = await readFile(join(vault, evidence?.path ?? ""), "utf8");
    expect(evidenceContent).toMatch(/\[the attached evidence\]\(\.\.\/Attachments\/[0-9a-f]{64}\.txt\)/);
    const attachmentHash = evidence?.attachmentHashes[0] ?? "";
    const attachmentPath = join(vault, "Attachments", `${attachmentHash}.txt`);
    expect(await readFile(attachmentPath)).toEqual(Buffer.from("Synthetic attachment data.\n"));

    const excluded = Object.values(state.sources).find((entry) => entry.title === "Passwords");
    const excludedContent = await readFile(join(vault, excluded?.path ?? ""), "utf8");
    expect(excludedContent).not.toContain("Synthetic excluded content");
  });

  it("does not rewrite byte-identical source files on a second refresh", async () => {
    const { vault, config, extract } = await setup();
    await refreshSourceMirror({ vault, extraction: await extract(), config });
    const firstState = await loadState(vault);
    const source = Object.values(firstState.sources).find((entry) => entry.title === "Frameworks");
    const sourcePath = join(vault, source?.path ?? "");
    const before = await stat(sourcePath);

    const result = await refreshSourceMirror({ vault, extraction: await extract(), config });

    expect(result).toMatchObject({ created: 0, updated: 0, noops: 7 });
    expect((await stat(sourcePath)).ino).toBe(before.ino);
  });

  it("removes an obsolete generated duplicate after a readable-path migration", async () => {
    const { vault, config, extract } = await setup();
    await refreshSourceMirror({ vault, extraction: await extract(), config });
    const state = await loadState(vault);
    const source = Object.values(state.sources).find((entry) => entry.title === "Frameworks")!;
    const stalePath = join(vault, "Notes/Obsolete Frameworks Copy.md");
    await writeFile(stalePath, await readFile(join(vault, source.path)));
    const humanPath = join(vault, "Notes/Human Scratchpad.md");
    await writeFile(humanPath, "# Human scratchpad\n");

    await refreshSourceMirror({ vault, extraction: await extract(), config });

    await expect(stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(humanPath, "utf8")).toBe("# Human scratchpad\n");
  });

  it("refuses to remove an obsolete generated duplicate that contains human-only additions", async () => {
    const { vault, config, extract } = await setup();
    await refreshSourceMirror({ vault, extraction: await extract(), config });
    const state = await loadState(vault);
    const source = Object.values(state.sources).find((entry) => entry.title === "Frameworks")!;
    const stalePath = join(vault, "Notes/Obsolete Frameworks With Human Work.md");
    const humanCopy = (await readFile(join(vault, source.path), "utf8"))
      .replace("## Local additions\n\n", "## Local additions\n\nKeep this human observation.\n");
    await writeFile(stalePath, humanCopy);

    await expect(refreshSourceMirror({ vault, extraction: await extract(), config }))
      .rejects.toMatchObject({ code: "source_mirror_modified" });
    expect(await readFile(stalePath, "utf8")).toContain("Keep this human observation.");
  });

  it("redacts a secret embedded in a note title before allocating its filename or metadata", async () => {
    const { vault, config, extract } = await setup();
    const extraction = await extract();
    const framework = extraction.census.notes.find((note) => note.title === "Frameworks")!;
    const rawSecret = "realistic-secret-value-123";
    framework.title = `SDK api_key=${rawSecret}`;
    config.sensitivity.excludedTitlePatterns = ["api[_ -]?key"];

    await refreshSourceMirror({ vault, extraction, config });

    const state = await loadState(vault);
    const source = state.sources[sha256(framework.id)]!;
    expect(source.title).not.toContain(rawSecret);
    expect(source.censusStatus).toBe("excluded");
    expect(source.path).not.toContain(rawSecret);
    expect(await readFile(join(vault, source.path), "utf8")).not.toContain(rawSecret);
    expect(source.path).toContain("REDACTED_SECRET");
  });

  it("preserves a human-modified source mirror and fails that refresh", async () => {
    const { vault, config, extract } = await setup();
    await refreshSourceMirror({ vault, extraction: await extract(), config });
    const state = await loadState(vault);
    const source = Object.values(state.sources).find((entry) => entry.title === "Frameworks");
    const sourcePath = join(vault, source?.path ?? "");
    await writeFile(sourcePath, "human source edit\n");

    await expect(
      refreshSourceMirror({ vault, extraction: await extract(), config }),
    ).rejects.toMatchObject({ code: "source_mirror_modified" });
    expect(await readFile(sourcePath, "utf8")).toBe("human source edit\n");
  });

  it("preserves structured human Connections and Local additions on refresh", async () => {
    const { vault, config, extract } = await setup();
    await refreshSourceMirror({ vault, extraction: await extract(), config });
    const state = await loadState(vault);
    const source = Object.values(state.sources).find((entry) => entry.title === "Frameworks")!;
    const sourcePath = join(vault, source.path);
    const human = (await readFile(sourcePath, "utf8"))
      .replace("## Connections\n\n", "## Connections\n\n- Related: [[Notes/Favorite Quotations|Favorite Quotations]]\n")
      .replace("## Local additions\n\n", "## Local additions\n\nExplore the tension between rigor and agency.\n");
    await writeFile(sourcePath, human);

    await refreshSourceMirror({ vault, extraction: await extract(), config });

    expect(await readFile(sourcePath, "utf8")).toBe(human);
    expect((await loadState(vault)).sources[source.noteIdHash]).toMatchObject({
      syncStatus: "clean",
      generatedHash: sha256(human),
    });
  });

  it("creates a human-readable review instead of guessing an ambiguous child reference", async () => {
    const { vault, config, extract } = await setup();
    const extraction = await extract();
    const frameworks = extraction.census.notes.find((note) => note.title === "Frameworks")!;
    frameworks.markdown = `${frameworks.markdown ?? ""}\n>>Duplicate title\n`;

    await refreshSourceMirror({ vault, extraction, config });

    const state = await loadState(vault);
    const unresolved = Object.values(state.unresolvedReferences);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({
      status: "ambiguous",
      label: "Duplicate title",
      candidates: expect.any(Array),
    });
    expect(unresolved[0]!.candidates).toHaveLength(2);
    const review = await readFile(join(vault, unresolved[0]!.reviewPath), "utf8");
    expect(review).toContain("# Unresolved note relationship");
    expect(review).toContain("Duplicate title");
    expect(review).toContain("[[Notes/Duplicate title — Folder A|Duplicate title]]");
    expect(review).toContain("[[Notes/Duplicate title — Moved Folder|Duplicate title]]");

    frameworks.markdown = (frameworks.markdown ?? "").replace("\n>>Duplicate title\n", "\n");
    await refreshSourceMirror({ vault, extraction, config });
    expect(Object.values((await loadState(vault)).unresolvedReferences)).toHaveLength(0);
    await expect(stat(join(vault, unresolved[0]!.reviewPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records recoverable missing-note metadata without deleting the source", async () => {
    const { vault, config, extract } = await setup();
    const complete = await extract();
    await refreshSourceMirror({ vault, extraction: complete, config });
    const before = await loadState(vault);
    const missingSource = Object.values(before.sources).find((entry) => entry.title === "Example Thinker");
    const missingPath = join(vault, missingSource?.path ?? "");
    const withoutExampleThinker: ExtractionResult = {
      ...complete,
      census: {
        ...complete.census,
        notes: complete.census.notes.filter((note) => note.title !== "Example Thinker"),
        coverage: { ...complete.census.coverage, noteCount: 6 },
      },
    };

    await refreshSourceMirror({ vault, extraction: withoutExampleThinker, config });
    const missingOnce = (await loadState(vault)).sources[missingSource?.noteIdHash ?? ""];
    expect(missingOnce).toMatchObject({
      censusStatus: "missing_upstream",
      missingCensusCount: 1,
      tombstoneObjectHash: sha256(await readFile(missingPath)),
    });
    expect(await readFile(missingPath, "utf8")).toContain("title: Example Thinker");

    await refreshSourceMirror({ vault, extraction: withoutExampleThinker, config });
    expect((await loadState(vault)).sources[missingSource?.noteIdHash ?? ""]?.missingCensusCount).toBe(
      2,
    );

    await refreshSourceMirror({ vault, extraction: complete, config });
    expect((await loadState(vault)).sources[missingSource?.noteIdHash ?? ""]).toMatchObject({
      censusStatus: "present",
      missingCensusCount: 0,
      path: missingSource?.path,
    });
  });

  it("publishes nothing on incomplete census or injected transaction failure", async () => {
    const { vault, config, extract } = await setup();
    const incomplete = await extract();
    incomplete.census.complete = false;
    await expect(
      refreshSourceMirror({ vault, extraction: incomplete, config }),
    ).rejects.toMatchObject({ code: "incomplete_census" });
    expect(Object.keys((await loadState(vault)).sources)).toHaveLength(0);

    const failingApply = createTransactionApplier({
      failureInjector(stage, index) {
        if (stage === "after_rename" && index === 0) throw new Error("source publish failed");
      },
    });
    await expect(
      refreshSourceMirror({
        vault,
        extraction: await extract(),
        config,
        transactionApplier: failingApply,
      }),
    ).rejects.toThrow("source publish failed");
    expect(Object.keys((await loadState(vault)).sources)).toHaveLength(0);
    expect(await readdir(join(vault, "Sources/Apple Notes"))).toEqual([]);
    expect(await readdir(join(vault, "Attachments"))).toEqual([]);
  });
});
