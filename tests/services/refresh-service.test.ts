import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CkbConfigSchema,
  CodexCompilerAdapter,
  FixtureNotesExtractor,
  LlmwikiCompilerAdapter,
  RefreshService,
  createTransactionApplier,
  initializeWorkspace,
  listReviews,
  loadState,
} from "../../src/index.js";
import type {
  ExtractionResult,
  LlmwikiFactory,
  NotesExtractor,
  ProcessRunner,
} from "../../src/index.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/apple-notes");

function compilerFactory(): LlmwikiFactory {
  return ({ root }) => ({
    async compile() {
      const source = (await readdir(join(root, "sources"))).sort()[0];
      if (!source) throw new Error("expected a compiler source");
      await mkdir(join(root, ".llmwiki"), { recursive: true });
      await writeFile(join(root, ".llmwiki/state.json"), '{"version":1}\n');
      await writeFile(
        join(root, "wiki/index.md"),
        `---\ntitle: Knowledge Index\nsources: [${source}]\n---\n# Knowledge Index\n\nCompiled. ^[${source}:1-2]\n`,
      );
      return {
        compiled: 1,
        skipped: 0,
        deleted: 0,
        concepts: [],
        pages: ["index"],
        errors: [],
      };
    },
    async lint() {
      return { errors: 0, warnings: 0, info: 0, results: [] };
    },
  });
}

function editableCompilerFactory(value: { compiled: string }): LlmwikiFactory {
  return ({ root }) => ({
    async compile() {
      const source = (await readdir(join(root, "sources"))).sort()[0];
      if (!source) throw new Error("expected a compiler source");
      const target = join(root, "wiki/index.md");
      const existing = await readFile(target, "utf8").catch(() =>
        `---\ntitle: Knowledge Index\nsources: [${source}]\n---\n# Knowledge Index\n\n## Human\nBaseline\n\n## Compiled\nVersion 1\n`,
      );
      const content = existing
        .replace(/^sources:.*$/m, `sources: [${source}]`)
        .replace(/(## Compiled\n)[^\n]*/, `$1${value.compiled}`);
      await writeFile(target, content);
      return {
        compiled: 1,
        skipped: 0,
        deleted: 0,
        concepts: [],
        pages: ["index"],
        errors: [],
      };
    },
    async lint() {
      return { errors: 0, warnings: 0, info: 0, results: [] };
    },
  });
}

function transformedExtractor(transform: (result: ExtractionResult) => void): NotesExtractor {
  const fixture = new FixtureNotesExtractor(fixtureRoot);
  return {
    async extract(options) {
      const result = await fixture.extract(options);
      transform(result);
      return result;
    },
  };
}

async function setup() {
  const vault = await mkdtemp(join(tmpdir(), "ckb-refresh-vault-"));
  await initializeWorkspace({ vault, dryRun: false });
  const config = CkbConfigSchema.parse({ schemaVersion: 1, vaultPath: vault });
  const service = new RefreshService({
    extractor: new FixtureNotesExtractor(fixtureRoot),
    compiler: new LlmwikiCompilerAdapter(compilerFactory()),
  });
  return { vault, config, service };
}

describe("refresh service", () => {
  it("promotes Codex manifest state and skips the model on a true no-op refresh", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-refresh-codex-"));
    await initializeWorkspace({ vault, dryRun: false });
    const compilerConfig = {
      adapter: "codex-agent" as const,
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high" as const,
    };
    const config = CkbConfigSchema.parse({
      schemaVersion: 1,
      vaultPath: vault,
      compiler: { primary: compilerConfig },
    });
    let modelCalls = 0;
    const runner: ProcessRunner = async (request) => {
      modelCalls += 1;
      const sources = (await readdir(join(request.cwd!, "sources"))).sort();
      const catalog = JSON.parse(await readFile(join(request.cwd!, "source-catalog.json"), "utf8"));
      const sourceIds = sources.map((source) => catalog[source].sourceId as string);
      await mkdir(join(request.cwd!, ".ckb-output"), { recursive: true });
      await writeFile(join(request.cwd!, ".ckb-output/graph-plan.json"), JSON.stringify({
        schemaVersion: 1,
        assignments: sourceIds.map((sourceId) => ({
          sourceId,
          primaryMoc: "frameworks-and-mental-models",
          secondaryMocs: [],
        })),
        inferredRelationships: [{
          fromSourceId: sourceIds[0],
          toSourceId: sourceIds[1],
          rationale: "The two fixture notes share a durable conceptual mechanism.",
          confidence: 0.91,
        }],
        wikiPages: [{
          path: "Wiki/Fixture.md",
          title: "Fixture",
          summary: "Complete fixture map.",
          body: "# Fixture\n\n## Core ideas\n\nFixture synthesis.\n",
          sourceIds,
        }],
        proposedMocs: [{
          title: "Science & Engineering",
          domainSlug: "technology",
          rationale: "The fixture contains recurring applied-science material.",
          sourceIds: [sourceIds[0]],
        }],
      }));
      const outputIndex = request.args.indexOf("-o");
      await writeFile(request.args[outputIndex + 1]!, JSON.stringify({
        status: "complete",
        compiled: 1,
        skipped: 0,
        deleted: 0,
        warnings: [],
      }));
      return { stdout: "{}\n", stderr: "", exitCode: 0, signal: null };
    };
    const service = new RefreshService({
      extractor: new FixtureNotesExtractor(fixtureRoot),
      compiler: new CodexCompilerAdapter(compilerConfig, runner),
      compilerConfig,
    });

    await service.refresh({ vault, config, dryRun: false });
    const graphState = await loadState(vault);
    expect(Object.values(graphState.sources).every((source) =>
      source.censusStatus !== "present" || source.primaryMoc === "frameworks-and-mental-models"
    )).toBe(true);
    expect(await readFile(join(vault, "Home.md"), "utf8"))
      .toContain("[[Domains/Thinking and Frameworks|Thinking and Frameworks]]");
    expect(await readFile(join(vault, "Domains/Thinking and Frameworks.md"), "utf8"))
      .toContain("[[MOCs/Frameworks & Mental Models|Frameworks & Mental Models]]");
    expect(await readFile(join(vault, "MOCs/Frameworks & Mental Models.md"), "utf8"))
      .toContain("[[Notes/Frameworks|Frameworks]]");
    expect(await readFile(join(vault, "Notes/Frameworks.md"), "utf8"))
      .toContain("Parent: [[MOCs/Frameworks & Mental Models|Frameworks & Mental Models]]");
    expect(await readFile(join(vault, "Views/All Notes.base"), "utf8"))
      .toContain('file.inFolder("Notes")');
    expect(await readFile(join(vault, "Reviews/Taxonomy/Science & Engineering.md"), "utf8"))
      .toContain("[[Notes/");
    const stateBeforeNoop = await readFile(join(vault, ".ckb/state.json"), "utf8");
    const homeBeforeNoop = await readFile(join(vault, "Home.md"), "utf8");
    const frameworksBeforeNoop = await readFile(join(vault, "Notes/Frameworks.md"), "utf8");
    const second = await service.refresh({ vault, config, dryRun: false });

    expect(modelCalls).toBe(1);
    expect(await readFile(join(vault, "Notes/Frameworks.md"), "utf8")).toBe(frameworksBeforeNoop);
    expect(second.changes.filter((change) => change.action !== "noop")).toEqual([]);
    expect(second).toMatchObject({
      noOp: true,
      compiler: { name: "codex-agent", compiled: 0 },
      sources: { created: 0, updated: 0, noops: 7 },
    });
    expect(await readFile(join(vault, ".ckb/state.json"), "utf8")).toBe(stateBeforeNoop);
    expect(await readFile(join(vault, "Home.md"), "utf8")).toBe(homeBeforeNoop);
    expect(JSON.parse(await readFile(join(vault, ".ckb/compiler/current/manifest.json"), "utf8")))
      .toMatchObject({ compiler: { name: "codex-agent", model: "gpt-5.6-sol" } });
  });

  it("forwards exact extraction scope controls", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-refresh-scope-"));
    await initializeWorkspace({ vault, dryRun: false });
    const config = CkbConfigSchema.parse({
      schemaVersion: 1,
      vaultPath: vault,
      extractor: {
        accountAllowlist: ["iCloud"],
        folderAllowlist: ["Frameworks"],
        noteIdAllowlist: ["x-coredata://SYNTHETIC/ICNote/p1"],
        maximumNoteCount: 1,
      },
    });
    const fixture = new FixtureNotesExtractor(fixtureRoot);
    let observed: Parameters<NotesExtractor["extract"]>[0] | undefined;
    const extractor: NotesExtractor = {
      async extract(options) {
        observed = options;
        return fixture.extract(options);
      },
    };
    await new RefreshService({
      extractor,
      compiler: new LlmwikiCompilerAdapter(compilerFactory()),
    }).refresh({ vault, config, dryRun: true });

    expect(observed).toMatchObject({
      accountAllowlist: ["iCloud"],
      folderAllowlist: ["Frameworks"],
      noteIdAllowlist: ["x-coredata://SYNTHETIC/ICNote/p1"],
      maximumNoteCount: 1,
    });
  });

  it("builds a full dry-run proposal without modifying the vault", async () => {
    const { vault, config, service } = await setup();
    const stateBefore = await readFile(join(vault, ".ckb/state.json"), "utf8");

    const result = await service.refresh({ vault, config, dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      sources: { created: 7, excluded: 1, inaccessible: 1 },
      wiki: { applied: ["Wiki/index.md"], reviews: [] },
    });
    expect(await readdir(join(vault, "Sources/Apple Notes"))).toEqual([]);
    expect(await readdir(join(vault, "Wiki"))).toEqual([]);
    expect(await readdir(join(vault, "Reviews"))).toEqual([]);
    expect(await readdir(join(vault, ".ckb/objects"))).toEqual([]);
    expect(await readFile(join(vault, ".ckb/state.json"), "utf8")).toBe(stateBefore);
  });

  it("publishes sources and wiki together, then leaves byte-identical pages untouched", async () => {
    const { vault, config, service } = await setup();

    const first = await service.refresh({ vault, config, dryRun: false });
    const wikiBefore = await readFile(join(vault, "Wiki/index.md"), "utf8");
    const sourceState = Object.values((await loadState(vault)).sources);
    const sourceBefore = await readFile(join(vault, sourceState[0]?.path ?? ""));

    const second = await service.refresh({ vault, config, dryRun: false });

    expect(first.wiki.applied).toEqual(["Wiki/index.md"]);
    expect(await readFile(join(vault, ".ckb/compiler/current/.llmwiki/state.json"), "utf8"))
      .toBe('{"version":1}\n');
    expect((await loadState(vault)).pipeline).toMatchObject({
      lastExtraction: { noteCount: 7, extractorName: "fixture" },
      lastCompilation: { compilerName: "llm-wiki-compiler", compiled: 1 },
    });
    expect(second.sources).toMatchObject({ created: 0, updated: 0, noops: 7 });
    expect(second.wiki.noops).toEqual(["Wiki/index.md"]);
    expect(await readFile(join(vault, "Wiki/index.md"), "utf8")).toBe(wikiBefore);
    expect(await readFile(join(vault, sourceState[0]?.path ?? ""))).toEqual(sourceBefore);
  });

  it("publishes nothing when compilation or the combined transaction fails", async () => {
    const { vault, config } = await setup();
    const failingCompiler = new LlmwikiCompilerAdapter(() => ({
      async compile() {
        throw new Error("provider failed");
      },
      async lint() {
        return { errors: 0, warnings: 0, info: 0, results: [] };
      },
    }));
    await expect(
      new RefreshService({
        extractor: new FixtureNotesExtractor(fixtureRoot),
        compiler: failingCompiler,
      }).refresh({ vault, config, dryRun: false }),
    ).rejects.toMatchObject({ code: "compiler_validation_failed" });
    expect(await readdir(join(vault, "Sources/Apple Notes"))).toEqual([]);
    expect(await readdir(join(vault, "Wiki"))).toEqual([]);

    const interrupted = createTransactionApplier({
      failureInjector(stage, index) {
        if (stage === "after_rename" && index === 0) throw new Error("interrupted publish");
      },
    });
    await expect(
      new RefreshService({
        extractor: new FixtureNotesExtractor(fixtureRoot),
        compiler: new LlmwikiCompilerAdapter(compilerFactory()),
        transactionApplier: interrupted,
      }).refresh({ vault, config, dryRun: false }),
    ).rejects.toThrow("interrupted publish");
    expect(await readdir(join(vault, "Sources/Apple Notes"))).toEqual([]);
    expect(await readdir(join(vault, "Wiki"))).toEqual([]);
    expect(Object.keys((await loadState(vault)).sources)).toHaveLength(0);
    await expect(access(join(vault, ".ckb/lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds one workspace lock through extraction, publication, and cache promotion", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-refresh-lock-"));
    await initializeWorkspace({ vault, dryRun: false });
    const config = CkbConfigSchema.parse({ schemaVersion: 1, vaultPath: vault });
    const fixture = new FixtureNotesExtractor(fixtureRoot);
    let announceStart!: () => void;
    let releaseExtraction!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStart = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    const extractor: NotesExtractor = {
      async extract(options) {
        announceStart();
        await gate;
        return fixture.extract(options);
      },
    };
    const service = new RefreshService({
      extractor,
      compiler: new LlmwikiCompilerAdapter(compilerFactory()),
    });
    const first = service.refresh({ vault, config, dryRun: false });
    await started;

    await expect(service.refresh({ vault, config, dryRun: true })).rejects.toMatchObject({
      code: "workspace_locked",
    });

    releaseExtraction();
    await first;
    await expect(access(join(vault, ".ckb/lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a stable source identity through content change, rename, and folder move", async () => {
    const { vault, config, service } = await setup();
    await service.refresh({ vault, config, dryRun: false });
    const original = Object.values((await loadState(vault)).sources).find(
      (source) => source.title === "Frameworks",
    );
    expect(original).toBeDefined();

    const change = (transform: (note: ExtractionResult["census"]["notes"][number]) => void) =>
      new RefreshService({
        extractor: transformedExtractor((result) => {
          const note = result.census.notes.find((candidate) => candidate.id === original?.sourceId.slice("apple-note:".length));
          const fallback = result.census.notes.find((candidate) => candidate.title === "Frameworks");
          transform(note ?? fallback!);
        }),
        compiler: new LlmwikiCompilerAdapter(compilerFactory()),
      });

    const changed = await change((note) => {
      note.markdown = `${note.markdown ?? ""}\nA new durable idea.\n`;
      note.modifiedAt = "2026-08-24T02:00:00.000Z";
    }).refresh({ vault, config, dryRun: false });
    expect(changed.sources).toMatchObject({ updated: 1, noops: 6 });

    const renamed = await change((note) => {
      note.title = "Framework Library";
    }).refresh({ vault, config, dryRun: false });
    // The renamed source and its explicit graph neighbor both receive readable link updates.
    expect(renamed.sources.updated).toBe(2);
    const afterRename = (await loadState(vault)).sources[original?.noteIdHash ?? ""];
    expect(afterRename).toMatchObject({
      path: "Notes/Framework Library.md",
      title: "Framework Library",
      aliases: expect.arrayContaining(["Frameworks"]),
    });
    expect(afterRename?.path).not.toBe(original?.path);
    await expect(access(join(vault, original?.path ?? ""))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(vault, afterRename?.path ?? ""))).resolves.toBeUndefined();

    const moved = await new RefreshService({
      extractor: transformedExtractor((result) => {
        const note = result.census.notes.find((candidate) => candidate.title === "Frameworks");
        if (!note) throw new Error("fixture note missing");
        note.title = "Framework Library";
        note.folderName = "Reference";
      }),
      compiler: new LlmwikiCompilerAdapter(compilerFactory()),
    }).refresh({ vault, config, dryRun: false });
    expect(moved.sources.updated).toBe(1);
    expect((await loadState(vault)).sources[original?.noteIdHash ?? ""]).toMatchObject({
      path: afterRename?.path,
      folder: "Reference",
    });
  });

  it("merges non-overlapping human edits and creates a pending review for collisions", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-refresh-vault-"));
    await initializeWorkspace({ vault, dryRun: false });
    const config = CkbConfigSchema.parse({ schemaVersion: 1, vaultPath: vault });
    const value = { compiled: "Version 1" };
    const service = new RefreshService({
      extractor: new FixtureNotesExtractor(fixtureRoot),
      compiler: new LlmwikiCompilerAdapter(editableCompilerFactory(value)),
    });
    await service.refresh({ vault, config, dryRun: false });

    const pagePath = join(vault, "Wiki/index.md");
    await writeFile(pagePath, (await readFile(pagePath, "utf8")).replace("Baseline", "Human note"));
    value.compiled = "Version 2";
    const merged = await service.refresh({ vault, config, dryRun: false });
    expect(merged.wiki.merged).toEqual(["Wiki/index.md"]);
    expect(await readFile(pagePath, "utf8")).toContain("Human note");
    expect(await readFile(pagePath, "utf8")).toContain("Version 2");

    await writeFile(pagePath, (await readFile(pagePath, "utf8")).replace("Version 2", "Human collision"));
    value.compiled = "Agent collision";
    const conflict = await service.refresh({ vault, config, dryRun: false });
    expect(conflict.wiki.applied).toEqual([]);
    expect(conflict.wiki.reviews).toHaveLength(1);
    expect(await readFile(pagePath, "utf8")).toContain("Human collision");
    expect(await readFile(pagePath, "utf8")).not.toContain("Agent collision");
    expect(await listReviews(vault)).toHaveLength(1);
  });
});
