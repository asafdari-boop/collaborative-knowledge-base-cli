import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePage } from "../../src/index.js";
import { LlmwikiCompilerAdapter } from "../../src/compiler/llmwiki-adapter.js";
import { stableGeneratedPageId } from "../../src/compiler/validate-output.js";
import type {
  LlmwikiFacade,
  LlmwikiFactory,
  LlmwikiProject,
} from "../../src/compiler/types.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { initializeWorkspace, CollaborationService, loadState, sha256 } from "../../src/index.js";

async function setupProject(): Promise<{ vault: string; project: LlmwikiProject; source: string }> {
  const vault = await mkdtemp(join(tmpdir(), "ckb-llmwiki-adapter-vault-"));
  await initializeWorkspace({ vault, dryRun: false });
  const live = "---\nckb_id: page:frameworks\ntitle: Frameworks\n---\nHuman context.\n";
  await mkdir(join(vault, "Wiki/concepts"), { recursive: true });
  await writeFile(join(vault, "Wiki/concepts/frameworks.md"), live);
  await new CollaborationService(vault).recordBase("Wiki/concepts/frameworks.md", live);

  const root = await mkdtemp(join(tmpdir(), "ckb-llmwiki-project-"));
  await mkdir(join(root, "sources"), { recursive: true });
  await mkdir(join(root, "wiki/concepts"), { recursive: true });
  const source = "apple-note-source.md";
  const sourceContent = [
    "---",
    "title: Frameworks source",
    "source: applenotes://note",
    "ingestedAt: 2026-08-24T00:00:00.000Z",
    "sourceType: file",
    "---",
    "A durable idea.",
    "",
  ].join("\n");
  await writeFile(join(root, "sources", source), sourceContent);
  await writeFile(join(root, "wiki/concepts/frameworks.md"), live);
  return {
    vault,
    source,
    project: {
      root,
      sourceFiles: [source],
      sourceHashes: { [source]: sha256(sourceContent) },
      liveWikiHashes: { "Wiki/concepts/frameworks.md": sha256(live) },
      sourceCatalog: {
        [source]: {
          sourceId: `apple-note:${"a".repeat(64)}`,
          title: "Frameworks source",
          path: "Notes/Frameworks source.md",
          filename: source,
        },
      },
    },
  };
}

function successfulFactory(source: string): LlmwikiFactory {
  return ({ root }) => {
    const facade: LlmwikiFacade = {
      async compile() {
        await writeFile(
          join(root, "wiki/concepts/frameworks.md"),
          [
            "---",
            "title: Frameworks",
            "summary: Durable reusable models.",
            `sources: [${source}]`,
            "updatedAt: 2026-08-24T01:00:00.000Z",
            "---",
            `A compiled claim. ^[${source}:1-2]`,
            "",
          ].join("\n"),
        );
        await writeFile(join(root, "wiki/index.md"), "# Knowledge Wiki\n");
        return {
          compiled: 1,
          skipped: 0,
          deleted: 0,
          concepts: ["Frameworks"],
          pages: ["frameworks"],
          errors: [],
        };
      },
      async lint() {
        return { errors: 0, warnings: 0, info: 0, results: [] };
      },
    };
    return facade;
  };
}

describe("llmwiki compiler adapter", () => {
  it("derives new page identity from content rather than its output path", () => {
    const generated = "---\ntitle: Knowledge Wiki\n---\n# Knowledge Wiki\n";
    const timestamped = `${generated}updatedAt: 2026-08-24T01:00:00.000Z\n`;
    const laterTimestamp = `${generated}updatedAt: 2026-08-25T01:00:00.000Z\n`;

    expect(stableGeneratedPageId(timestamped)).toBe(stableGeneratedPageId(laterTimestamp));
    expect(stableGeneratedPageId(`${generated}Different body.\n`)).not.toBe(
      stableGeneratedPageId(generated),
    );
    expect(stableGeneratedPageId(generated)).toMatch(/^page:auto:[0-9a-f]{32}$/);
  });

  it("turns isolated compiler output into ID-preserving collaboration proposals", async () => {
    const { vault, project, source } = await setupProject();
    const before = await readFile(join(vault, "Wiki/concepts/frameworks.md"), "utf8");
    const adapter = new LlmwikiCompilerAdapter(successfulFactory(source));

    const result = await adapter.compile({ vault, project, concurrency: 2 });

    expect(result.compiler).toEqual({ name: "llm-wiki-compiler", version: "1.1.0" });
    expect(result.proposals.map((proposal) => proposal.path)).toEqual([
      "Wiki/concepts/frameworks.md",
      "Wiki/index.md",
    ]);
    const frameworks = result.proposals[0];
    expect(parsePage(frameworks?.content ?? "").id).toBe("page:frameworks");
    expect(frameworks?.sourceHashes).toEqual([project.sourceHashes[source]]);
    expect(await readFile(join(vault, "Wiki/concepts/frameworks.md"), "utf8")).toBe(before);
    expect(Object.keys((await loadState(vault)).pages)).toEqual(["page:frameworks"]);
    expect(parsePage(result.proposals[1]?.content ?? "").id).toMatch(/^page:auto:[0-9a-f]{32}$/);
  });

  it("scopes a configured llmwiki provider to one compilation", async () => {
    const { vault, project, source } = await setupProject();
    const previous = process.env.LLMWIKI_PROVIDER;
    process.env.LLMWIKI_PROVIDER = "openai";
    let observedProvider: string | undefined;
    const delegate = successfulFactory(source);
    const factory: LlmwikiFactory = (options) => {
      observedProvider = process.env.LLMWIKI_PROVIDER;
      return delegate(options);
    };

    try {
      await new LlmwikiCompilerAdapter(factory).compile({
        vault,
        project,
        concurrency: 1,
        provider: "claude-agent",
      });
      expect(observedProvider).toBe("claude-agent");
      expect(process.env.LLMWIKI_PROVIDER).toBe("openai");
    } finally {
      if (previous === undefined) delete process.env.LLMWIKI_PROVIDER;
      else process.env.LLMWIKI_PROVIDER = previous;
    }
  });

  it("fails closed on compiler errors or lint errors", async () => {
    const { vault, project } = await setupProject();
    const compilerFailure: LlmwikiFactory = () => ({
      async compile() {
        return {
          compiled: 0,
          skipped: 0,
          deleted: 0,
          concepts: [],
          pages: [],
          errors: ["provider failed"],
        };
      },
      async lint() {
        return { errors: 0, warnings: 0, info: 0, results: [] };
      },
    });
    await expect(
      new LlmwikiCompilerAdapter(compilerFailure).compile({ vault, project, concurrency: 1 }),
    ).rejects.toMatchObject({ code: "compiler_validation_failed" });

    const lintFailure: LlmwikiFactory = ({ root }) => ({
      async compile() {
        await mkdir(join(root, "wiki/concepts"), { recursive: true });
        await writeFile(join(root, "wiki/concepts/broken.md"), "# Broken\n");
        return {
          compiled: 1,
          skipped: 0,
          deleted: 0,
          concepts: ["Broken"],
          pages: ["broken"],
          errors: [],
        };
      },
      async lint() {
        return {
          errors: 1,
          warnings: 0,
          info: 0,
          results: [
            {
              rule: "broken-citation",
              severity: "error",
              file: "wiki/concepts/broken.md",
              message: "missing source",
            },
          ],
        };
      },
    });
    await expect(
      new LlmwikiCompilerAdapter(lintFailure).compile({ vault, project, concurrency: 1 }),
    ).rejects.toMatchObject({ code: "compiler_validation_failed" });
  });
});
