import { isAbsolute, resolve } from "node:path";
import { CompilerValidationError } from "../core/errors.js";
import {
  materializeGraphWiki,
  readAndValidateGraphPlan,
} from "./codex-adapter.js";
import type {
  CompilerAdapterInput,
  CompilerAdapterResult,
  KnowledgeCompiler,
} from "./types.js";
import { collectCompilerProposals, verifyCompilerSources } from "./validate-output.js";

export const PRECOMPUTED_GRAPH_ADAPTER_VERSION = "1.0.0";

/**
 * Reuses a previously generated graph plan only after validating it against the
 * exact staged source catalog. It never trusts assignments or provenance from a
 * different corpus.
 */
export class PrecomputedGraphCompilerAdapter implements KnowledgeCompiler {
  private readonly planPath: string;

  public constructor(planPath: string) {
    if (!isAbsolute(planPath)) {
      throw new CompilerValidationError("The precomputed graph plan path must be absolute");
    }
    this.planPath = resolve(planPath);
  }

  public async compile(input: CompilerAdapterInput): Promise<CompilerAdapterResult> {
    if (input.rebuild !== true) {
      throw new CompilerValidationError("A precomputed graph plan may only be used for a full rebuild");
    }
    await verifyCompilerSources(input.project);
    const graphPlan = await readAndValidateGraphPlan(input, this.planPath);
    await materializeGraphWiki(input.project, graphPlan);
    const proposals = await collectCompilerProposals(input.vault, input.project);
    const uncited = proposals.filter((proposal) => (proposal.sourceHashes ?? []).length === 0);
    if (uncited.length > 0) {
      throw new CompilerValidationError(
        `Precomputed graph plan emitted pages without source provenance: ${uncited.map((page) => page.path).join(", ")}`,
      );
    }
    return {
      compiler: {
        name: "validated-graph-plan",
        version: PRECOMPUTED_GRAPH_ADAPTER_VERSION,
        model: "precomputed",
      },
      compile: {
        compiled: input.project.sourceFiles.length,
        skipped: 0,
        deleted: 0,
        concepts: [],
        pages: proposals.map((proposal) => proposal.path),
        errors: [],
      },
      lint: { errors: 0, warnings: 0, info: 0, results: [] },
      proposals,
      stagingRoot: input.project.root,
      graphPlan,
    };
  }
}
