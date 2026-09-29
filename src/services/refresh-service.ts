import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CkbConfig } from "../config/schema.js";
import { newOperationId } from "../core/ids.js";
import type { NotesExtractor, ExtractionWarning } from "../extractors/types.js";
import { planSourceMirrorRefresh, type SourceRefreshResult } from "../normalization/source-plan.js";
import type { SourceTransactionApplier } from "../normalization/source-plan.js";
import { createLlmwikiStagingProject } from "../compiler/llmwiki-project.js";
import type { KnowledgeCompiler } from "../compiler/types.js";
import { CollaborationService, type PublishResult } from "./collaboration-service.js";
import { sha256 } from "../core/hash.js";
import { resolveInside } from "../core/paths.js";
import { applyTransaction, type TransactionChange } from "../publishing/transaction.js";
import { acquireWorkspaceLock } from "../publishing/lock.js";
import {
  hashWikiDirectory,
  writeSuccessfulCompilerManifest,
} from "../compiler/incremental-manifest.js";
import { applyGraphPlanToState } from "../graph/apply-plan.js";
import { renderKnowledgeGraph } from "../graph/render.js";
import { validateRenderedGraph } from "../graph/validate.js";
import { calculateGraphMetrics, type GraphMetrics } from "../graph/metrics.js";
import { DEFAULT_TAXONOMY } from "../graph/taxonomy.js";
import {
  replaceFirstClassPageConnections,
  updateFirstClassPageGraph,
} from "../normalization/note-page.js";
import {
  buildSourceReferenceIndex,
  renderExplicitConnections,
} from "../graph/explicit-links.js";
import { sanitizeReadableTitle } from "../normalization/readable-path.js";
import { renderAllNotesBase } from "../obsidian/base.js";
import {
  renderObsidianAppearanceSettings,
  renderObsidianGraphSettings,
} from "../obsidian/settings.js";
import type { CompileProposal } from "./collaboration-service.js";

export interface RefreshServiceDependencies {
  extractor: NotesExtractor;
  compiler: KnowledgeCompiler;
  compilerConfig?: CkbConfig["compiler"]["primary"];
  transactionApplier?: SourceTransactionApplier;
}

export interface RefreshOptions {
  vault: string;
  config: CkbConfig;
  dryRun: boolean;
  rebuild?: boolean;
  signal?: AbortSignal;
}

export interface PlannedChangeSummary {
  path: string;
  area: "source" | "attachment" | "wiki" | "review";
  action: "create" | "update" | "delete" | "noop";
  currentHash: string | null;
  proposedHash: string | null;
}

export interface RefreshResult {
  operationId: string;
  dryRun: boolean;
  noOp: boolean;
  sources: SourceRefreshResult;
  wiki: PublishResult;
  compiler: {
    name: string;
    version: string;
    compiled: number;
    skipped: number;
    deleted: number;
    lintWarnings: number;
  };
  graph?: GraphMetrics;
  warnings: ExtractionWarning[];
  changes: PlannedChangeSummary[];
}

function areaFor(path: string): PlannedChangeSummary["area"] {
  if (path.startsWith("Sources/") || path.startsWith("Notes/")) return "source";
  if (path.startsWith("Attachments/")) return "attachment";
  if (path.startsWith("Reviews/")) return "review";
  return "wiki";
}

async function supportChange(vault: string, path: string, content: string): Promise<TransactionChange> {
  let current: Buffer | null;
  try {
    current = await readFile(resolveInside(vault, path));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    current = null;
  }
  return { path, expectedHash: current === null ? null : sha256(current), content };
}

async function preservedSupportChange(
  vault: string,
  path: string,
  generatedContent: string,
): Promise<TransactionChange> {
  let content = generatedContent;
  try {
    content = await readFile(resolveInside(vault, path), "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return supportChange(vault, path, content);
}

function taxonomyProposalContent(
  proposal: NonNullable<Awaited<ReturnType<KnowledgeCompiler["compile"]>>["graphPlan"]>["proposedMocs"][number],
  sourceById: ReadonlyMap<string, { path: string; title: string }>,
): string {
  const domain = DEFAULT_TAXONOMY.domains.find((candidate) => candidate.slug === proposal.domainSlug)!;
  const sources = proposal.sourceIds.map((sourceId) => sourceById.get(sourceId)!).filter(Boolean);
  return [
    "---",
    "ckb_review_type: taxonomy-proposal",
    "status: pending",
    `domain: ${JSON.stringify(proposal.domainSlug)}`,
    "---",
    `# Proposed MOC: ${proposal.title}`,
    "",
    `Parent domain: [[Domains/${domain.title}|${domain.title}]]`,
    "",
    "## Why it may deserve its own MOC",
    "",
    proposal.rationale,
    "",
    "## Supporting notes",
    "",
    ...sources.map((source) => `- [[${source.path.replace(/\.md$/, "")}|${source.title}]]`),
    "",
    "> This is a review proposal. It does not change the approved taxonomy until you explicitly accept it.",
    "",
  ].join("\n");
}

function summarizeChange(change: TransactionChange): PlannedChangeSummary {
  const proposedHash = change.content === null ? null : sha256(change.content);
  const action = change.expectedHash === proposedHash
    ? "noop"
    : change.expectedHash === null
      ? "create"
      : change.content === null
        ? "delete"
        : "update";
  return {
    path: change.path,
    area: areaFor(change.path),
    action,
    currentHash: change.expectedHash,
    proposedHash,
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function promoteCompilerState(vault: string, compilerRoot: string): Promise<void> {
  const llmwikiSource = join(compilerRoot, ".llmwiki");
  const manifestSource = join(compilerRoot, ".ckb-compiler/manifest.json");
  const hasLlmwiki = await isDirectory(llmwikiSource);
  let hasManifest = false;
  try {
    hasManifest = (await lstat(manifestSource)).isFile();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!hasLlmwiki && !hasManifest) return;
  const parent = join(vault, ".ckb/compiler");
  await mkdir(parent, { recursive: true });
  const target = join(parent, "current");
  const suffix = randomUUID();
  const temporary = join(parent, `.current.tmp-${suffix}`);
  const backup = join(parent, `.current.backup-${suffix}`);
  await mkdir(temporary, { recursive: true });
  if (hasLlmwiki) {
    await cp(llmwikiSource, join(temporary, ".llmwiki"), {
      recursive: true,
      errorOnExist: true,
    });
  }
  if (hasManifest) {
    await cp(manifestSource, join(temporary, "manifest.json"), { errorOnExist: true });
  }
  const hadTarget = await isDirectory(target);
  try {
    if (hadTarget) await rename(target, backup);
    await rename(temporary, target);
    if (hadTarget) await rm(backup, { recursive: true, force: true });
  } catch (error: unknown) {
    await rm(temporary, { recursive: true, force: true });
    if (hadTarget && !(await isDirectory(target)) && (await isDirectory(backup))) {
      await rename(backup, target);
    }
    throw error;
  }
}

export class RefreshService {
  public constructor(private readonly dependencies: RefreshServiceDependencies) {}

  public async refresh(options: RefreshOptions): Promise<RefreshResult> {
    const vault = resolve(options.vault);
    const operationId = newOperationId();
    const refreshLock = await acquireWorkspaceLock(vault, operationId);
    let stagingRoot: string | null = null;
    try {
      stagingRoot = await mkdtemp(join(tmpdir(), "ckb-refresh-"));
      const extractionDirectory = join(stagingRoot, "extraction");
      const compilerDirectory = join(stagingRoot, "compiler");
      await mkdir(extractionDirectory);
      await mkdir(compilerDirectory);
      const extraction = await this.dependencies.extractor.extract({
        stagingDirectory: extractionDirectory,
        accountAllowlist: options.config.extractor.accountAllowlist,
        folderAllowlist: options.config.extractor.folderAllowlist,
        noteIdAllowlist: options.config.extractor.noteIdAllowlist,
        maximumNoteCount: options.config.extractor.maximumNoteCount,
        timeoutMs: options.config.extractor.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const sourcePlan = await planSourceMirrorRefresh({
        vault,
        extraction,
        config: options.config,
        operationId,
      });
      const previousCompilerRoot = join(vault, ".ckb/compiler/current");
      const project = await createLlmwikiStagingProject({
        vault,
        stagingDirectory: compilerDirectory,
        sourceDocuments: sourcePlan.sources,
        rebuild: options.rebuild === true,
        ...((await isDirectory(previousCompilerRoot)) ? { previousCompilerRoot } : {}),
      });
      const selectedCompiler = this.dependencies.compilerConfig ?? options.config.compiler.primary;
      const compiled = await this.dependencies.compiler.compile({
        vault,
        project,
        concurrency: options.config.compiler.concurrency,
        ...(selectedCompiler.adapter === "llmwiki" &&
            selectedCompiler.provider !== "environment"
          ? { provider: selectedCompiler.provider }
          : {}),
        rebuild: options.rebuild === true,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      let successfulSourceHashes = project.sourceHashes;
      if (compiled.graphPlan) {
        sourcePlan.nextState = applyGraphPlanToState(
          sourcePlan.nextState,
          compiled.graphPlan,
          project.manifest?.rebuild ?? options.rebuild === true,
        );
        const references = Object.values(sourcePlan.nextState.sources).map((source) => ({
          sourceId: source.sourceId,
          noteIdHash: source.noteIdHash,
          title: source.title,
          aliases: source.aliases,
          path: source.path,
        }));
        const referenceIndex = buildSourceReferenceIndex(references);
        const relationships = Object.values(sourcePlan.nextState.relationships);
        const stateByPath = new Map(Object.values(sourcePlan.nextState.sources)
          .map((source) => [source.path, source] as const));
        for (const source of sourcePlan.sources.filter((candidate) => candidate.compilerEligible)) {
          const state = stateByPath.get(source.path)!;
          source.content = replaceFirstClassPageConnections(
            source.content,
            renderExplicitConnections(state.sourceId, relationships, referenceIndex),
          );
          source.generatedHash = sha256(source.content);
          const change = sourcePlan.changes.find((candidate) =>
            candidate.path === source.path && candidate.content !== null
          );
          if (change) change.content = source.content;
        }
        successfulSourceHashes = Object.fromEntries(sourcePlan.sources
          .filter((source) => source.compilerEligible)
          .map((source) => [basename(source.path), source.generatedHash]));
      }
      const graphEnabled = compiled.graphPlan !== undefined ||
        Object.values(sourcePlan.nextState.sources).some((source) => Boolean(source.primaryMoc));
      let graphMetrics: GraphMetrics | undefined;
      let graphProposals: CompileProposal[] = [];
      const graphSupportChanges: TransactionChange[] = [];
      if (compiled.graphPlan?.proposedMocs.length) {
        const sourceById = new Map(Object.values(sourcePlan.nextState.sources)
          .map((source) => [source.sourceId, { path: source.path, title: source.title }] as const));
        for (const proposal of compiled.graphPlan.proposedMocs) {
          const path = `Reviews/Taxonomy/${sanitizeReadableTitle(proposal.title)}.md`;
          graphSupportChanges.push(await preservedSupportChange(
            vault,
            path,
            taxonomyProposalContent(proposal, sourceById),
          ));
        }
      }
      if (graphEnabled) {
        const graphSources = Object.values(sourcePlan.nextState.sources)
          .filter((source) => source.censusStatus === "present" && source.primaryMoc);
        const assignments = graphSources.map((source) => ({
          sourceId: source.sourceId,
          primaryMoc: source.primaryMoc!,
          secondaryMocs: source.secondaryMocs ?? [],
        }));
        const rendered = renderKnowledgeGraph({
          taxonomy: DEFAULT_TAXONOMY,
          sources: graphSources,
          assignments,
          relationships: Object.values(sourcePlan.nextState.relationships),
          wikiPages: Object.values(sourcePlan.nextState.wikiSynthesis),
          mocDirectChildLimit: options.config.graph.mocDirectChildLimit,
        });
        const mocTitle = new Map(DEFAULT_TAXONOMY.mocs.map((moc) => [moc.slug, moc.title]));
        for (const renderedConnections of rendered.sourceConnections) {
          const state = graphSources.find((source) => source.sourceId === renderedConnections.sourceId)!;
          const source = sourcePlan.sources.find((candidate) => candidate.path === state.path);
          if (!source) continue;
          const previousConnectionsHash = sourcePlan.previousConnectionHashes[state.sourceId];
          const updated = updateFirstClassPageGraph({
            content: source.content,
            generatedConnections: renderedConnections.content,
            primaryMocTitle: mocTitle.get(state.primaryMoc!) ?? state.primaryMoc!,
            secondaryMocTitles: (state.secondaryMocs ?? []).map((slug) => mocTitle.get(slug) ?? slug),
            ...(previousConnectionsHash
              ? { generatedConnectionsBaseHash: previousConnectionsHash }
              : {}),
          });
          source.content = updated.content;
          source.generatedHash = sha256(updated.content);
          state.generatedHash = source.generatedHash;
          state.connectionsRegionHash = sha256(updated.connections);
          state.syncStatus = "clean";
          const change = sourcePlan.changes.find((candidate) =>
            candidate.path === state.path && candidate.content !== null
          );
          if (change) change.content = updated.content;
        }
        graphProposals = rendered.pages.map((page) => ({ ...page, sourceHashes: [] }));
        const proposedPages = [
          ...rendered.pages,
          ...sourcePlan.sources.filter((source) => source.compilerEligible)
            .map((source) => ({ path: source.path, content: source.content })),
          ...compiled.proposals.map((proposal) => ({ path: proposal.path, content: proposal.content })),
        ];
        validateRenderedGraph(proposedPages);
        graphMetrics = calculateGraphMetrics(proposedPages);
        graphSupportChanges.push(
          await supportChange(vault, "Views/All Notes.base", renderAllNotesBase()),
          await supportChange(vault, ".obsidian/graph.json", renderObsidianGraphSettings()),
          await supportChange(vault, ".obsidian/appearance.json", renderObsidianAppearanceSettings()),
        );
      }
      const collaboration = new CollaborationService(vault);
      const wikiPlan = await collaboration.planProposals([...compiled.proposals, ...graphProposals], {
        operationId,
        stateSnapshot: {
          state: sourcePlan.nextState,
          hash: sourcePlan.expectedStateHash,
        },
      });
      wikiPlan.nextState.pipeline = {
        lastSuccessfulRefreshAt: new Date().toISOString(),
        lastExtraction: {
          operationId,
          completedAt: extraction.census.completedAt,
          extractorName: extraction.census.extractor.name,
          extractorVersion: extraction.census.extractor.version,
          noteCount: extraction.census.coverage.noteCount,
          warningCount: extraction.census.warnings.length,
          unsupportedAccounts: extraction.census.coverage.unsupportedAccounts,
        },
        lastCompilation: {
          operationId,
          compilerName: compiled.compiler.name,
          compilerVersion: compiled.compiler.version,
          ...(compiled.compiler.model ? { compilerModel: compiled.compiler.model } : {}),
          compiled: compiled.compile.compiled,
          skipped: compiled.compile.skipped,
          deleted: compiled.compile.deleted,
          lintWarnings: compiled.lint.warnings,
        },
      };
      const changes = [...sourcePlan.changes, ...wikiPlan.changes];
      changes.push(...graphSupportChanges);
      const noOp = compiled.compile.compiled === 0 &&
        compiled.compile.deleted === 0 &&
        wikiPlan.internalChanges.length === 0 &&
        wikiPlan.result.reviews.length === 0 &&
        changes.every((change) => summarizeChange(change).action === "noop");
      const sourceResult = noOp
        ? {
            ...sourcePlan.result,
            created: 0,
            updated: 0,
            noops: extraction.census.notes.length,
            attachmentFilesCreated: 0,
          }
        : sourcePlan.result;
      const result: RefreshResult = {
        operationId,
        dryRun: options.dryRun,
        noOp,
        sources: sourceResult,
        wiki: wikiPlan.result,
        compiler: {
          name: compiled.compiler.name,
          version: compiled.compiler.version,
          compiled: compiled.compile.compiled,
          skipped: compiled.compile.skipped,
          deleted: compiled.compile.deleted,
          lintWarnings: compiled.lint.warnings,
        },
        warnings: extraction.census.warnings,
        changes: changes.map(summarizeChange),
        ...(graphMetrics ? { graph: graphMetrics } : {}),
      };
      if (options.dryRun || noOp) return result;

      const transactionApplier = this.dependencies.transactionApplier ?? applyTransaction;
      await transactionApplier({
        vault,
        actor: `refresh:apple-notes-${compiled.compiler.name}`,
        operationId,
        lock: refreshLock,
        changes,
        internalChanges: wikiPlan.internalChanges,
        objects: wikiPlan.objects,
        nextState: wikiPlan.nextState,
        expectedStateHash: sourcePlan.expectedStateHash,
      });
      try {
        await writeSuccessfulCompilerManifest({
          compilerRoot: compiled.stagingRoot,
          compiler: compiled.compiler,
          sourceHashes: successfulSourceHashes,
          wikiHashes: await hashWikiDirectory(join(vault, "Wiki")),
        });
        await promoteCompilerState(vault, compiled.stagingRoot);
      } catch (error: unknown) {
        result.warnings.push({
          code: "compiler_cache_promotion_failed",
          message: `Refresh was published, but the disposable compiler cache was not promoted: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return result;
    } finally {
      if (stagingRoot !== null) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      await refreshLock.release();
    }
  }
}
