import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { stringify } from "yaml";
import { CompilerValidationError } from "../core/errors.js";
import { runProcess, type ProcessRunner } from "../extractors/process-runner.js";
import { parsePage } from "../pages/frontmatter.js";
import { buildCodexCommand } from "./codex-command.js";
import { CODEX_RUN_REPORT_SCHEMA, codexKnowledgeInstructions } from "./codex-instructions.js";
import { collectCompilerProposals, verifyCompilerSources } from "./validate-output.js";
import type { CompilerAdapterInput, CompilerAdapterResult, KnowledgeCompiler } from "./types.js";
import { GraphPlanSchema, type GraphPlan } from "./graph-schema.js";
import { validateGraphPlan } from "./graph-plan.js";
import { DEFAULT_TAXONOMY } from "../graph/taxonomy.js";
import { extractWikilinkTargets } from "../graph/validate.js";

export const CODEX_ADAPTER_VERSION = "1.0.0";

const ReportSchema = z.object({
  status: z.literal("complete"),
  compiled: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export interface CodexAdapterConfig {
  executable: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  timeoutMs?: number;
}

async function assertExpectedProjectEntries(root: string): Promise<void> {
  const allowed = new Set([
    ".ckb-compiler",
    ".llmwiki",
    "CKB_INSTRUCTIONS.md",
    "incremental-manifest.json",
    "run-report.json",
    "run-report.schema.json",
    "graph-plan.schema.json",
    "graph-state.json",
    "source-catalog.json",
    "taxonomy.json",
    ".ckb-output",
    "sources",
    "wiki",
  ]);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new CompilerValidationError(`Codex output contains a root symlink: ${entry.name}`);
    }
    if (!allowed.has(entry.name)) {
      throw new CompilerValidationError(`Codex wrote outside the allowed staging areas: ${entry.name}`);
    }
  }
}

export async function readAndValidateGraphPlan(
  input: CompilerAdapterInput,
  planPath = join(input.project.root, ".ckb-output/graph-plan.json"),
): Promise<GraphPlan> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(planPath, "utf8"));
  } catch (error: unknown) {
    throw new CompilerValidationError(
      `Codex graph plan is missing or malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sourceIds = new Set(Object.values(input.project.sourceCatalog).map((source) => source.sourceId));
  const affectedFilenames = input.project.manifest?.rebuild
    ? Object.keys(input.project.sourceCatalog)
    : [
        ...(input.project.manifest?.newSources ?? []),
        ...(input.project.manifest?.changedSources ?? []),
      ];
  const affectedSourceIds = new Set(
    affectedFilenames.map((filename) => input.project.sourceCatalog[filename]?.sourceId)
      .filter((sourceId): sourceId is string => Boolean(sourceId)),
  );
  return validateGraphPlan(raw, {
    sourceIds,
    mocSlugs: new Set(DEFAULT_TAXONOMY.mocs.map((moc) => moc.slug)),
    domainSlugs: new Set(DEFAULT_TAXONOMY.domains.map((domain) => domain.slug)),
    inferenceCapPerNote: 5,
    rebuild: input.project.manifest?.rebuild ?? input.rebuild === true,
    affectedSourceIds,
  });
}

export async function materializeGraphWiki(
  project: CompilerAdapterInput["project"],
  plan: GraphPlan,
): Promise<void> {
  const bySourceId = new Map(
    Object.values(project.sourceCatalog).map((source) => [source.sourceId, source]),
  );
  for (const page of plan.wikiPages) {
    const sources = page.sourceIds.map((sourceId) => bySourceId.get(sourceId)!);
    const sourceLinks = sources.map((source) =>
      `- [[${source.path.replace(/\.md$/, "")}|${source.title}]]`
    );
    const frontmatter = stringify({
      title: page.title,
      summary: page.summary,
      sources: sources.map((source) => source.filename),
    }, { lineWidth: 0 });
    const body = `${page.body.trim()}\n\n## Source notes\n\n${sourceLinks.join("\n")}\n`;
    const target = join(project.root, ...page.path.replace(/^Wiki\//, "wiki/").split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `---\n${frontmatter}---\n${body}`);
  }
}

function sanitizedFailure(stderr: string, stdout: string): string {
  const diagnostic = `${stderr}\n${stdout}`;
  if (/not logged in|authentication|unauthorized|login required/i.test(diagnostic)) return "authentication";
  if (/quota|rate.?limit|usage limit|credit/i.test(diagnostic)) return "quota";
  return "abnormal_exit";
}

function validateKnowledgeGraph(
  proposals: CompilerAdapterResult["proposals"],
  sourceFiles: string[],
  requireCompleteCoverage: boolean,
): void {
  const resolvable = new Set<string>();
  const citedOutsideHome = new Set<string>();
  for (const source of sourceFiles) {
    resolvable.add(source);
    resolvable.add(source.replace(/\.md$/, ""));
  }
  for (const proposal of proposals) {
    const relativePath = proposal.path.replace(/^Wiki\//, "").replace(/\.md$/, "");
    resolvable.add(relativePath);
    resolvable.add(relativePath.split("/").at(-1) ?? relativePath);
    const parsed = parsePage(proposal.content);
    if (typeof parsed.attributes.title === "string") resolvable.add(parsed.attributes.title);
  }
  for (const proposal of proposals) {
    const parsed = parsePage(proposal.content);
    const sources = parsed.attributes.sources;
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new CompilerValidationError(`Codex page has no source provenance: ${proposal.path}`);
    }
    if (proposal.path === "Wiki/Home.md" && sources.length > 24) {
      throw new CompilerValidationError("Codex Home page cites more than 24 representative sources");
    }
    let hasInlineCitation = false;
    for (const source of sources) {
      if (typeof source !== "string") continue;
      if (proposal.path !== "Wiki/Home.md") citedOutsideHome.add(source);
      if (parsed.body.includes(`^[${source}`)) hasInlineCitation = true;
    }
    const navigationPage = proposal.path === "Wiki/Home.md" || proposal.path.startsWith("Wiki/MOCs/");
    if (!hasInlineCitation && !navigationPage) {
      throw new CompilerValidationError(`Codex page has no inline source citation: ${proposal.path}`);
    }
    for (const target of extractWikilinkTargets(proposal.content)) {
      const raw = target.replace(/^Wiki\//, "").replace(/\.md$/, "");
      if (!resolvable.has(raw)) {
        throw new CompilerValidationError(`Codex page has an unresolved wikilink [[${raw}]]: ${proposal.path}`);
      }
    }
    if (proposal.path === "Wiki/MOCs/Source Index.md") {
      const missingLinks = (sources as string[]).filter((source) =>
        !proposal.content.includes(`[[${source}|`) &&
        !proposal.content.includes(`[[${source.replace(/\.md$/, "")}|`)
      );
      if (missingLinks.length > 0) {
        throw new CompilerValidationError(
          `Codex Source Index has ${missingLinks.length} unlinked source entries`,
        );
      }
    }
  }
  if (requireCompleteCoverage) {
    const missing = sourceFiles.filter((source) => !citedOutsideHome.has(source));
    if (missing.length > 0) {
      throw new CompilerValidationError(
        `Codex rebuild omitted ${missing.length} eligible source${missing.length === 1 ? "" : "s"}`,
      );
    }
  }
}

export class CodexCompilerAdapter implements KnowledgeCompiler {
  private readonly runner: ProcessRunner;

  public constructor(
    private readonly config: CodexAdapterConfig,
    runner: ProcessRunner = runProcess,
  ) {
    this.runner = runner;
  }

  public async compile(input: CompilerAdapterInput): Promise<CompilerAdapterResult> {
    const manifest = input.project.manifest;
    if (!manifest) throw new CompilerValidationError("Codex project is missing its incremental manifest");
    if (manifest.noOp && input.rebuild !== true) {
      await verifyCompilerSources(input.project);
      const proposals = await collectCompilerProposals(input.vault, input.project);
      return {
        compiler: { name: "codex-agent", version: CODEX_ADAPTER_VERSION, model: this.config.model },
        compile: {
          compiled: 0,
          skipped: input.project.sourceFiles.length,
          deleted: 0,
          concepts: [],
          pages: [],
          errors: [],
        },
        lint: { errors: 0, warnings: 0, info: 0, results: [] },
        proposals,
        stagingRoot: input.project.root,
      };
    }

    const instructionsPath = join(input.project.root, "CKB_INSTRUCTIONS.md");
    const schemaPath = join(input.project.root, "run-report.schema.json");
    const reportPath = join(input.project.root, "run-report.json");
    const graphSchemaPath = join(input.project.root, "graph-plan.schema.json");
    await writeFile(instructionsPath, codexKnowledgeInstructions(manifest), { flag: "wx" });
    await writeFile(schemaPath, `${JSON.stringify(CODEX_RUN_REPORT_SCHEMA, null, 2)}\n`, { flag: "wx" });
    await writeFile(graphSchemaPath, `${JSON.stringify(z.toJSONSchema(GraphPlanSchema), null, 2)}\n`, { flag: "wx" });
    const command = buildCodexCommand({
      ...this.config,
      root: input.project.root,
      schemaPath,
      reportPath,
    });
    const processResult = await this.runner({
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      timeoutMs: this.config.timeoutMs ?? 60 * 60 * 1000,
      maxOutputBytes: 32 * 1024 * 1024,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (processResult.exitCode !== 0) {
      throw new CompilerValidationError(
        `Codex compile failed (${sanitizedFailure(processResult.stderr, processResult.stdout)})`,
      );
    }
    let report;
    try {
      report = ReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
    } catch {
      throw new CompilerValidationError("Codex compile returned a malformed structured report");
    }
    await assertExpectedProjectEntries(input.project.root);
    await verifyCompilerSources(input.project);
    const graphPlan = await readAndValidateGraphPlan(input);
    await materializeGraphWiki(input.project, graphPlan);
    const proposals = await collectCompilerProposals(input.vault, input.project);
    const uncited = proposals.filter((proposal) => (proposal.sourceHashes ?? []).length === 0);
    if (uncited.length > 0) {
      throw new CompilerValidationError(
        `Codex emitted pages without source provenance: ${uncited.map((page) => page.path).join(", ")}`,
      );
    }
    return {
      compiler: { name: "codex-agent", version: CODEX_ADAPTER_VERSION, model: this.config.model },
      compile: {
        compiled: report.compiled,
        skipped: report.skipped,
        deleted: report.deleted,
        concepts: [],
        pages: proposals.map((proposal) => proposal.path),
        errors: [],
      },
      lint: {
        errors: 0,
        warnings: report.warnings.length,
        info: 0,
        results: report.warnings.map((message) => ({
          rule: "codex-warning",
          severity: "warning" as const,
          file: "run-report.json",
          message,
        })),
      },
      proposals,
      stagingRoot: input.project.root,
      graphPlan,
    };
  }
}
