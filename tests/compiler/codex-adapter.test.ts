import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexCompilerAdapter,
  PrecomputedGraphCompilerAdapter,
  createLlmwikiStagingProject,
  initializeWorkspace,
  sha256,
} from "../../src/index.js";
import type { ProcessRunner } from "../../src/index.js";

async function setup(rebuild = true) {
  const vault = await mkdtemp(join(tmpdir(), "ckb-codex-vault-"));
  await initializeWorkspace({ vault, dryRun: false });
  const content = [
    "---",
    "title: Frameworks",
    "source: applenotes://note",
    "sourceType: file",
    "ingestedAt: 2026-08-31T00:00:00.000Z",
    "appleNoteId: note",
    "---",
    "A durable idea.",
    "",
  ].join("\n");
  const project = await createLlmwikiStagingProject({
    vault,
    stagingDirectory: await mkdtemp(join(tmpdir(), "ckb-codex-stage-")),
    rebuild,
    sourceDocuments: [{
      path: "Notes/Frameworks.md",
      content,
      generatedHash: sha256(content),
      compilerEligible: true,
    }],
  });
  return { vault, project, source: "Frameworks.md" };
}

describe("Codex compiler adapter", () => {
  it("revalidates and materializes an explicitly supplied precomputed graph plan", async () => {
    const { vault, project, source } = await setup();
    const sourceId = project.sourceCatalog[source]!.sourceId;
    const planPath = join(await mkdtemp(join(tmpdir(), "ckb-plan-")), "graph-plan.json");
    await writeFile(planPath, JSON.stringify({
      schemaVersion: 1,
      assignments: [{ sourceId, primaryMoc: "frameworks-and-mental-models", secondaryMocs: [] }],
      inferredRelationships: [],
      wikiPages: [{
        path: "Wiki/Frameworks.md",
        title: "Frameworks",
        summary: "Durable frameworks.",
        body: "# Frameworks\n\n## Core ideas\n\nA durable claim.\n",
        sourceIds: [sourceId],
      }],
      proposedMocs: [],
    }));

    const result = await new PrecomputedGraphCompilerAdapter(planPath)
      .compile({ vault, project, concurrency: 3, rebuild: true });

    expect(result.compiler).toMatchObject({ name: "validated-graph-plan" });
    expect(result.graphPlan?.assignments).toHaveLength(1);
    expect(result.proposals[0]?.content).toContain("[[Notes/Frameworks|Frameworks]]");
    expect(result.proposals[0]?.sourceHashes).toEqual([project.sourceHashes[source]]);
  });

  it("rejects a precomputed graph plan that does not cover the current rebuild corpus", async () => {
    const { vault, project } = await setup();
    const planPath = join(await mkdtemp(join(tmpdir(), "ckb-plan-invalid-")), "graph-plan.json");
    await writeFile(planPath, JSON.stringify({
      schemaVersion: 1,
      assignments: [],
      inferredRelationships: [],
      wikiPages: [],
      proposedMocs: [],
    }));

    await expect(new PrecomputedGraphCompilerAdapter(planPath)
      .compile({ vault, project, concurrency: 3, rebuild: true }))
      .rejects.toThrow(/omitted 1 source assignment/i);
  });

  it("turns confined staged output into collaboration proposals", async () => {
    const { vault, project, source } = await setup();
    const runner: ProcessRunner = async (request) => {
      expect(request.executable).toBe("/Applications/ChatGPT.app/Contents/Resources/codex");
      expect(request.cwd).toBe(project.root);
      const sourceId = project.sourceCatalog[source]!.sourceId;
      await mkdir(join(project.root, ".ckb-output"), { recursive: true });
      await writeFile(join(project.root, ".ckb-output/graph-plan.json"), JSON.stringify({
        schemaVersion: 1,
        assignments: [{ sourceId, primaryMoc: "frameworks-and-mental-models", secondaryMocs: [] }],
        inferredRelationships: [],
        wikiPages: [{
          path: "Wiki/Frameworks.md",
          title: "Frameworks",
          summary: "Durable frameworks.",
          body: "# Frameworks\n\n## Core ideas\n\nA durable claim.\n\n## Questions for reflection\n\nWhere does this fail?\n",
          sourceIds: [sourceId],
        }],
        proposedMocs: [],
      }));
      const outputIndex = request.args.indexOf("-o");
      await writeFile(request.args[outputIndex + 1]!, JSON.stringify({
        status: "complete",
        compiled: 1,
        skipped: 0,
        deleted: 0,
        warnings: [],
      }));
      return { stdout: '{"type":"turn.completed"}\n', stderr: "", exitCode: 0, signal: null };
    };
    const result = await new CodexCompilerAdapter({
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    }, runner).compile({ vault, project, concurrency: 3, rebuild: true });

    expect(result.compiler).toMatchObject({ name: "codex-agent", model: "gpt-5.6-sol" });
    expect(result.graphPlan?.assignments).toHaveLength(1);
    expect(result.proposals.map((proposal) => proposal.path)).toEqual(["Wiki/Frameworks.md"]);
    expect(result.proposals[0]?.sourceHashes).toEqual([project.sourceHashes[source]]);
    expect(result.proposals[0]?.content).toContain("[[Notes/Frameworks|Frameworks]]");
    expect(result.proposals[0]?.content).not.toContain("^[apple-note-");
    expect(await readFile(join(vault, "Wiki/Frameworks.md"), "utf8").catch(() => null)).toBeNull();
  });

  it("does not start a model for a true no-op", async () => {
    const { vault, project } = await setup(false);
    project.manifest = { ...project.manifest!, rebuild: false, rebuildReason: null, noOp: true };
    let calls = 0;
    const runner: ProcessRunner = async () => {
      calls += 1;
      throw new Error("must not run");
    };
    const result = await new CodexCompilerAdapter({
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    }, runner).compile({ vault, project, concurrency: 3 });
    expect(calls).toBe(0);
    expect(result.compile.compiled).toBe(0);
  });

  it("classifies an authentication failure without leaking provider output", async () => {
    const { vault, project } = await setup();
    const runner: ProcessRunner = async () => ({
      stdout: "private body must not appear",
      stderr: "Not logged in. Run codex login.",
      exitCode: 1,
      signal: null,
    });
    await expect(new CodexCompilerAdapter({
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    }, runner).compile({ vault, project, concurrency: 3 })).rejects.toMatchObject({
      code: "compiler_validation_failed",
      message: "Codex compile failed (authentication)",
    });
  });
});
