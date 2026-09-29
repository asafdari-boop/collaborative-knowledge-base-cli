import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CkbConfigSchema,
  CollaborationService,
  FixtureNotesExtractor,
  createLlmwikiStagingProject,
  initializeWorkspace,
  loadState,
  refreshSourceMirror,
  sha256,
} from "../../src/index.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/apple-notes");

async function setup() {
  const vault = await mkdtemp(join(tmpdir(), "ckb-compiler-vault-"));
  await initializeWorkspace({ vault, dryRun: false });
  const config = CkbConfigSchema.parse({ schemaVersion: 1, vaultPath: vault });
  const extractor = new FixtureNotesExtractor(fixtureRoot);
  const extraction = await extractor.extract({
    stagingDirectory: await mkdtemp(join(tmpdir(), "ckb-compiler-extract-")),
    accountAllowlist: [],
    folderAllowlist: [],
    timeoutMs: 1_000,
  });
  await refreshSourceMirror({ vault, extraction, config });
  const existing = "---\nckb_id: page:existing\ntitle: Existing\n---\nHuman context.\n";
  await mkdir(join(vault, "Wiki/concepts"), { recursive: true });
  await writeFile(join(vault, "Wiki/concepts/existing.md"), existing);
  await new CollaborationService(vault).recordBase("Wiki/concepts/existing.md", existing);
  return { vault };
}

describe("llmwiki staging project", () => {
  it("can stage planned source documents before the live mirror is published", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-compiler-vault-"));
    await initializeWorkspace({ vault, dryRun: false });
    const content = `---\ntitle: Planned\nsource: Apple Notes\nsourceType: file\ningestedAt: 2026-08-24T00:00:00.000Z\nappleNoteId: planned-note\n---\nPlanned body.\n`;

    const project = await createLlmwikiStagingProject({
      vault,
      stagingDirectory: await mkdtemp(join(tmpdir(), "ckb-compiler-stage-")),
      sourceDocuments: [
        {
          path: "Notes/Planned.md",
          content,
          generatedHash: sha256(content),
          compilerEligible: true,
        },
      ],
    });

    expect(project.sourceFiles).toEqual(["Planned.md"]);
    expect(await readFile(join(project.root, "sources/Planned.md"), "utf8"))
      .toBe(content);
    expect(project.sourceCatalog["Planned.md"]).toMatchObject({
      title: "Planned",
      path: "Notes/Planned.md",
    });
    expect(JSON.parse(await readFile(join(project.root, "source-catalog.json"), "utf8")))
      .toHaveProperty("Planned.md");
    await expect(readFile(join(vault, "Notes/Planned.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies only compiler-eligible sources, prior state, and a live wiki snapshot", async () => {
    const { vault } = await setup();
    const stagingDirectory = await mkdtemp(join(tmpdir(), "ckb-compiler-stage-"));
    const previousCompilerRoot = await mkdtemp(join(tmpdir(), "ckb-compiler-previous-"));
    await mkdir(join(previousCompilerRoot, ".llmwiki"), { recursive: true });
    await writeFile(join(previousCompilerRoot, ".llmwiki/state.json"), '{"version":1}\n');

    const project = await createLlmwikiStagingProject({
      vault,
      stagingDirectory,
      previousCompilerRoot,
    });

    expect(project.root).not.toBe(vault);
    expect(project.root.startsWith(stagingDirectory)).toBe(true);
    expect(project.sourceFiles).toHaveLength(5);
    expect(await readdir(join(project.root, "sources"))).toHaveLength(5);
    expect(await readFile(join(project.root, ".llmwiki/state.json"), "utf8")).toBe(
      '{"version":1}\n',
    );
    expect(await readFile(join(project.root, "wiki/concepts/existing.md"), "utf8")).toContain(
      "Human context.",
    );
    const sourceCorpus = (
      await Promise.all(
        project.sourceFiles.map((filename) => readFile(join(project.root, "sources", filename), "utf8")),
      )
    ).join("\n");
    expect(sourceCorpus).not.toContain("Synthetic excluded content");
    expect(sourceCorpus).not.toContain("unavailable or locked");
  });

  it("fails when a supposedly generated source has drifted", async () => {
    const { vault } = await setup();
    const source = Object.values((await loadState(vault)).sources).find(
      (entry) => entry.censusStatus === "present",
    );
    await writeFile(join(vault, source?.path ?? ""), "drifted\n");

    await expect(
      createLlmwikiStagingProject({
        vault,
        stagingDirectory: await mkdtemp(join(tmpdir(), "ckb-compiler-stage-")),
      }),
    ).rejects.toMatchObject({ code: "source_mirror_modified" });
  });
});
