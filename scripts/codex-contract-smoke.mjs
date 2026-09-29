import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexCompilerAdapter,
  createLlmwikiStagingProject,
  initializeWorkspace,
  sha256,
} from "../dist/index.js";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: node scripts/codex-contract-smoke.mjs /absolute/path/to/codex");

const sandbox = await mkdtemp(join(tmpdir(), "ckb-codex-contract-"));
const vault = join(sandbox, "vault");
try {
  await initializeWorkspace({ vault, dryRun: false });
  const source = "apple-note-0000000000000001.md";
  const content = [
    "---",
    "title: Synthetic Decision Framework",
    "source: applenotes://synthetic",
    "sourceType: file",
    "ingestedAt: 2026-08-31T00:00:00.000Z",
    "---",
    "Use reversible experiments when uncertainty is high.",
    "",
  ].join("\n");
  const project = await createLlmwikiStagingProject({
    vault,
    stagingDirectory: join(sandbox, "staging"),
    rebuild: true,
    sourceDocuments: [{
      path: `Sources/Apple Notes/${source}`,
      content,
      generatedHash: sha256(content),
      compilerEligible: true,
    }],
  });
  const result = await new CodexCompilerAdapter({
    executable,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    timeoutMs: 10 * 60 * 1000,
  }).compile({ vault, project, concurrency: 1, rebuild: true });
  process.stdout.write(`${JSON.stringify({
    compiler: result.compiler,
    compiled: result.compile.compiled,
    pages: result.proposals.map((proposal) => proposal.path),
    sourceUnchanged: sha256(await readFile(join(project.root, "sources", source))) === sha256(content),
  }, null, 2)}\n`);
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
