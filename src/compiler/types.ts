import type {
  CompileResult as LlmwikiCompileResult,
  LintSummary as LlmwikiLintSummary,
} from "llm-wiki-compiler";
import type { CompileProposal } from "../services/collaboration-service.js";
import type { IncrementalCompilerManifest } from "./incremental-manifest.js";
import type { GraphPlan } from "./graph-schema.js";

export interface StagedSourceCatalogEntry {
  sourceId: string;
  title: string;
  path: string;
  filename: string;
}

export interface LlmwikiProject {
  root: string;
  sourceFiles: string[];
  sourceHashes: Record<string, string>;
  liveWikiHashes: Record<string, string>;
  manifest?: IncrementalCompilerManifest;
  sourceCatalog: Record<string, StagedSourceCatalogEntry>;
}

export interface LlmwikiFacade {
  compile(options?: { review?: boolean; concurrency?: number }): Promise<LlmwikiCompileResult>;
  lint(): Promise<LlmwikiLintSummary>;
}

export type LlmwikiFactory = (options: { root: string }) => LlmwikiFacade;

export interface CompilerAdapterInput {
  vault: string;
  project: LlmwikiProject;
  concurrency: number;
  provider?: "anthropic" | "claude-agent" | "openai" | "ollama" | "minimax" | "copilot";
  rebuild?: boolean;
  signal?: AbortSignal;
}

export interface CompilerAdapterResult {
  compiler: { name: string; version: string; model?: string };
  compile: LlmwikiCompileResult;
  lint: LlmwikiLintSummary;
  proposals: CompileProposal[];
  stagingRoot: string;
  graphPlan?: GraphPlan;
}

export interface KnowledgeCompiler {
  compile(input: CompilerAdapterInput): Promise<CompilerAdapterResult>;
}
