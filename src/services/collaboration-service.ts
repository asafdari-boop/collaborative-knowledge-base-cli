import { readFile } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import {
  CompilerValidationError,
  PageIdentityMismatchError,
  PageNotTrackedError,
  StaleRevisionError,
} from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { newOperationId } from "../core/ids.js";
import { assertNoSymlinkAncestors, resolveInside } from "../core/paths.js";
import { ensurePageId, parsePage } from "../pages/frontmatter.js";
import { reconcilePage } from "../collaboration/reconcile.js";
import { applyTransaction, type TransactionChange } from "../publishing/transaction.js";
import { planReview, type ReviewRecord } from "../reviews/review-store.js";
import { getObject, putObject } from "../state/object-store.js";
import { loadStateSnapshot, type StateSnapshot } from "../state/state-store.js";
import type { PageState, WorkspaceState } from "../state/types.js";
import { extractWikilinkTargets } from "../graph/validate.js";
import { SuccessfulCompilerManifestSchema } from "../compiler/incremental-manifest.js";

export interface DirectPagePatch {
  path: string;
  expectedHash: string;
  content: string;
  actor?: string;
}

export interface SharedPageSnapshot {
  path: string;
  pageId: string;
  hash: string;
  content: string;
}

export interface CreateSynthesisPageInput {
  path: string;
  content: string;
  sourcePaths: string[];
  actor?: string;
}

export interface CompileProposal {
  path: string;
  content: string;
  expectedHash?: string;
  sourceHashes?: string[];
}

export interface PublishResult {
  operationId: string | null;
  applied: string[];
  merged: string[];
  noops: string[];
  adopted: string[];
  moved: string[];
  reviews: ReviewRecord[];
}

export interface PlanProposalsOptions {
  operationId?: string;
  stateSnapshot?: StateSnapshot;
}

export interface ProposalPublicationPlan {
  operationId: string;
  changes: TransactionChange[];
  internalChanges: TransactionChange[];
  objects: string[];
  nextState: WorkspaceState;
  expectedStateHash: string;
  stateChanged: boolean;
  result: PublishResult;
}

function cloneState(state: WorkspaceState): WorkspaceState {
  return structuredClone(state);
}

function pageAtPath(state: WorkspaceState, path: string): PageState | undefined {
  return Object.values(state.pages).find((page) => page.path === path);
}

function requirePageId(content: string, path: string): string {
  const id = parsePage(content).id;
  if (!id) throw new PageIdentityMismatchError(path);
  return id;
}

function assertSamePageId(path: string, before: string, after: string): string {
  const beforeId = requirePageId(before, path);
  const afterId = requirePageId(after, path);
  if (beforeId !== afterId) throw new PageIdentityMismatchError(path);
  return beforeId;
}

export class CollaborationService {
  public constructor(private readonly vault: string) {}

  private canonicalPath(path: string): string {
    const absolute = resolveInside(this.vault, path);
    return relative(this.vault, absolute).split(sep).join("/");
  }

  private async readLive(path: string): Promise<string> {
    const absolute = resolveInside(this.vault, path);
    await assertNoSymlinkAncestors(this.vault, absolute);
    return readFile(absolute, "utf8");
  }

  private async readLiveOptional(path: string): Promise<string | null> {
    try {
      return await this.readLive(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  public async readPage(suppliedPath: string): Promise<SharedPageSnapshot> {
    const path = this.canonicalPath(suppliedPath);
    const content = await this.readLive(path);
    const pageId = requirePageId(content, path);
    const state = (await loadStateSnapshot(this.vault)).state;
    const tracked = state.pages[pageId];
    if (!tracked || tracked.path !== path) throw new PageNotTrackedError(path);
    return { path, pageId, hash: sha256(content), content };
  }

  public async createSynthesisPage(input: CreateSynthesisPageInput): Promise<{
    kind: "created";
    operationId: string;
    path: string;
    pageId: string;
  }> {
    const path = this.canonicalPath(input.path);
    if (!path.startsWith("Wiki/") || !path.endsWith(".md")) {
      throw new CompilerValidationError("A synthesis page must be created under Wiki/ as Markdown");
    }
    const existing = await this.readLiveOptional(path);
    if (existing !== null) throw new StaleRevisionError(path, null, sha256(existing));
    const parsed = parsePage(input.content);
    const pageId = requirePageId(input.content, path);
    const title = parsed.attributes.title;
    const summary = parsed.attributes.summary;
    if (typeof title !== "string" || !title.trim() ||
        typeof summary !== "string" || !summary.trim()) {
      throw new CompilerValidationError("A synthesis page requires title and summary frontmatter");
    }
    const stateSnapshot = await loadStateSnapshot(this.vault);
    if (stateSnapshot.state.pages[pageId] || pageAtPath(stateSnapshot.state, path)) {
      throw new PageIdentityMismatchError(path);
    }
    const sourceByPath = new Map(Object.values(stateSnapshot.state.sources)
      .map((source) => [source.path, source] as const));
    const sourcePaths = [...new Set(input.sourcePaths.map((sourcePath) => this.canonicalPath(sourcePath)))];
    if (sourcePaths.length === 0) {
      throw new CompilerValidationError("A synthesis page requires at least one source note");
    }
    const sourceRecords = sourcePaths.map((sourcePath) => {
      const source = sourceByPath.get(sourcePath);
      if (!source || source.censusStatus !== "present") {
        throw new CompilerValidationError(`Synthesis source is unavailable: ${sourcePath}`);
      }
      return source;
    });
    const citedTargets = new Set(extractWikilinkTargets(input.content)
      .map((target) => target.endsWith(".md") ? target : `${target}.md`));
    const uncited = sourcePaths.filter((sourcePath) => !citedTargets.has(sourcePath));
    if (uncited.length > 0) {
      throw new CompilerValidationError(`Synthesis page is missing readable source links: ${uncited.join(", ")}`);
    }
    const expectedSourceNames = [...new Set(sourcePaths.map((sourcePath) => basename(sourcePath)))].sort();
    const declaredSources = Array.isArray(parsed.attributes.sources)
      ? parsed.attributes.sources.filter((source): source is string => typeof source === "string").sort()
      : [];
    if (JSON.stringify(declaredSources) !== JSON.stringify(expectedSourceNames)) {
      throw new CompilerValidationError("Synthesis sources frontmatter must match the cited source notes");
    }
    const sourceHashes = sourceRecords.map((source) => source.generatedHash ?? source.contentHash)
      .filter((hash): hash is string => Boolean(hash)).sort();
    if (sourceHashes.length !== sourceRecords.length) {
      throw new CompilerValidationError("A synthesis source is missing its published hash");
    }
    const plan = await this.planProposals([{
      path,
      content: input.content,
      sourceHashes,
    }], { stateSnapshot });
    plan.nextState.wikiSynthesis[path] = {
      path,
      title: title.trim(),
      summary: summary.trim(),
      sourceIds: sourceRecords.map((source) => source.sourceId),
    };
    const manifestPath = ".ckb/compiler/current/manifest.json";
    const manifestContent = await this.readLiveOptional(manifestPath);
    if (manifestContent !== null) {
      const manifest = SuccessfulCompilerManifestSchema.parse(JSON.parse(manifestContent));
      manifest.wikiHashes[path] = sha256(input.content);
      plan.internalChanges.push({
        path: manifestPath,
        expectedHash: sha256(manifestContent),
        content: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    }
    await applyTransaction({
      vault: this.vault,
      actor: input.actor ?? "human-agent:synthesis-create",
      operationId: plan.operationId,
      changes: plan.changes,
      internalChanges: plan.internalChanges,
      objects: plan.objects,
      nextState: plan.nextState,
      expectedStateHash: plan.expectedStateHash,
    });
    return { kind: "created", operationId: plan.operationId, path, pageId };
  }

  public async recordBase(
    suppliedPath: string,
    content: string,
    sourceHashes: string[] = [],
  ): Promise<{ operationId: string; pageId: string }> {
    const path = this.canonicalPath(suppliedPath);
    const live = await this.readLive(path);
    if (live !== content) {
      throw new StaleRevisionError(path, sha256(content), sha256(live));
    }
    const pageId = requirePageId(content, path);
    const stateSnapshot = await loadStateSnapshot(this.vault);
    const state = stateSnapshot.state;
    const conflictingPath = pageAtPath(state, path);
    if (conflictingPath && conflictingPath.pageId !== pageId) {
      throw new PageIdentityMismatchError(path);
    }
    const existing = state.pages[pageId];
    const aliases = existing
      ? [...new Set([...existing.aliases, ...(existing.path === path ? [] : [existing.path])])]
      : [];
    const baseHash = sha256(content);
    const baseObjectHash = await putObject(this.vault, content);
    const operationId = newOperationId();
    const nextState = cloneState(state);
    nextState.pages[pageId] = {
      pageId,
      path,
      aliases,
      baseHash,
      baseObjectHash,
      sourceHashes,
      lastOperationId: operationId,
    };
    await applyTransaction({
      vault: this.vault,
      actor: "collaboration:record-base",
      operationId,
      changes: [{ path, expectedHash: baseHash, content }],
      nextState,
      expectedStateHash: stateSnapshot.hash,
    });
    return { operationId, pageId };
  }

  public async patchPage(
    patch: DirectPagePatch,
  ): Promise<{ kind: "applied" | "noop"; operationId: string | null }> {
    const path = this.canonicalPath(patch.path);
    const live = await this.readLive(path);
    const decision = reconcilePage({
      base: live,
      live,
      proposed: patch.content,
      expectedHash: patch.expectedHash,
      directPatch: true,
    });
    if (decision.kind === "stale_revision") {
      throw new StaleRevisionError(path, decision.expectedHash, decision.actualHash);
    }
    if (decision.kind === "noop") return { kind: "noop", operationId: null };
    if (decision.kind !== "apply") throw new PageIdentityMismatchError(path);

    const pageId = assertSamePageId(path, live, decision.content);
    const stateSnapshot = await loadStateSnapshot(this.vault);
    const state = stateSnapshot.state;
    const tracked = state.pages[pageId];
    if (!tracked || tracked.path !== path) throw new PageNotTrackedError(path);
    const operationId = newOperationId();
    const baseHash = sha256(decision.content);
    const baseObjectHash = await putObject(this.vault, decision.content);
    const nextState = cloneState(state);
    nextState.pages[pageId] = {
      ...tracked,
      baseHash,
      baseObjectHash,
      lastOperationId: operationId,
    };
    await applyTransaction({
      vault: this.vault,
      actor: patch.actor ?? "agent:patch",
      operationId,
      changes: [{ path, expectedHash: patch.expectedHash, content: decision.content }],
      nextState,
      expectedStateHash: stateSnapshot.hash,
    });
    return { kind: "applied", operationId };
  }

  public async planProposals(
    proposals: CompileProposal[],
    options: PlanProposalsOptions = {},
  ): Promise<ProposalPublicationPlan> {
    const stateSnapshot = options.stateSnapshot ?? (await loadStateSnapshot(this.vault));
    const state = stateSnapshot.state;
    const nextState = cloneState(state);
    const operationId = options.operationId ?? newOperationId();
    const changes: TransactionChange[] = [];
    const internalChanges: TransactionChange[] = [];
    const objects: string[] = [];
    const applied: string[] = [];
    const merged: string[] = [];
    const noops: string[] = [];
    const adopted: string[] = [];
    const moved: string[] = [];
    const conflicts: Array<{
      page: PageState;
      path: string;
      base: string;
      live: string;
      proposed: string;
    }> = [];
    const seen = new Set<string>();
    const seenPageIds = new Set<string>();

    for (const proposal of proposals) {
      const path = this.canonicalPath(proposal.path);
      if (seen.has(path)) throw new PageIdentityMismatchError(path);
      seen.add(path);
      const proposalPageId = requirePageId(proposal.content, path);
      if (seenPageIds.has(proposalPageId)) throw new PageIdentityMismatchError(path);
      seenPageIds.add(proposalPageId);
      let page = pageAtPath(state, path);
      if (!page) {
        const live = await this.readLiveOptional(path);
        const pageId = proposalPageId;
        const existingIdentity = state.pages[pageId];
        if (existingIdentity && existingIdentity.path !== path) {
          const liveId = live === null ? undefined : parsePage(live).id;
          const previousLive = await this.readLiveOptional(existingIdentity.path);
          if (liveId !== pageId || previousLive !== null) {
            throw new PageIdentityMismatchError(path);
          }
          page = {
            ...existingIdentity,
            path,
            aliases: [...new Set([...existingIdentity.aliases, existingIdentity.path])],
          };
          nextState.pages[pageId] = page;
          moved.push(path);
        }
        if (!page) {
          if (proposal.expectedHash !== undefined) {
            throw new StaleRevisionError(
              path,
              proposal.expectedHash,
              live === null ? null : sha256(live),
            );
          }
          if (live !== null) {
            const liveId = parsePage(live).id;
            if (liveId && liveId !== pageId) throw new PageIdentityMismatchError(path);
            const adoptedContent = ensurePageId(live, pageId).content;
            const baseHash = sha256(adoptedContent);
            nextState.pages[pageId] = {
              pageId,
              path,
              aliases: [],
              baseHash,
              baseObjectHash: baseHash,
              sourceHashes: [],
              lastOperationId: operationId,
            };
            changes.push({ path, expectedHash: sha256(live), content: adoptedContent });
            objects.push(adoptedContent);
            adopted.push(path);
            continue;
          }
          const baseHash = sha256(proposal.content);
          nextState.pages[pageId] = {
            pageId,
            path,
            aliases: [],
            baseHash,
            baseObjectHash: baseHash,
            sourceHashes: proposal.sourceHashes ?? [],
            lastOperationId: operationId,
          };
          changes.push({ path, expectedHash: null, content: proposal.content });
          objects.push(proposal.content);
          applied.push(path);
          continue;
        }
      }
      if (!page.baseHash || !page.baseObjectHash) throw new PageNotTrackedError(path);
      if (proposal.expectedHash !== undefined && proposal.expectedHash !== page.baseHash) {
        throw new StaleRevisionError(path, proposal.expectedHash, page.baseHash);
      }
      const base = await getObject(this.vault, page.baseObjectHash);
      if (sha256(base) !== page.baseHash) {
        throw new StaleRevisionError(path, page.baseHash, sha256(base));
      }
      const live = await this.readLive(path);
      assertSamePageId(path, live, proposal.content);
      const decision = reconcilePage({
        base,
        live,
        proposed: proposal.content,
        expectedHash: page.baseHash,
      });

      if (decision.kind === "stale_revision") {
        throw new StaleRevisionError(path, decision.expectedHash, decision.actualHash);
      }
      if (decision.kind === "conflict") {
        conflicts.push({ page, path, base, live, proposed: proposal.content });
        continue;
      }

      const sharedContent = decision.kind === "noop" ? live : decision.content;
      const baseHash = sha256(sharedContent);
      const baseObjectHash = sha256(sharedContent);
      objects.push(sharedContent);
      nextState.pages[page.pageId] = {
        ...page,
        baseHash,
        baseObjectHash,
        sourceHashes: proposal.sourceHashes ?? page.sourceHashes,
        lastOperationId: operationId,
      };
      if (decision.kind === "noop") {
        noops.push(path);
      } else {
        changes.push({ path, expectedHash: sha256(live), content: decision.content });
        applied.push(path);
        if (decision.mode === "merged") merged.push(path);
      }
    }

    const reviews: ReviewRecord[] = [];
    for (const conflict of conflicts) {
      const review = await planReview({
        vault: this.vault,
        pageId: conflict.page.pageId,
        path: conflict.path,
        base: conflict.base,
        live: conflict.live,
        proposed: conflict.proposed,
        reason: "merge_conflict",
      });
      reviews.push(review.record);
      changes.push(review.liveAssertion);
      changes.push(review.visibleChange);
      internalChanges.push(review.internalChange);
      objects.push(...review.objects);
    }

    const stateChanged =
      applied.length > 0 || noops.length > 0 || adopted.length > 0 || moved.length > 0;
    return {
      operationId,
      changes,
      internalChanges,
      objects,
      nextState,
      expectedStateHash: stateSnapshot.hash,
      stateChanged,
      result: {
        operationId: stateChanged || reviews.length > 0 ? operationId : null,
        applied,
        merged,
        noops,
        adopted,
        moved,
        reviews,
      },
    };
  }

  public async publishProposals(proposals: CompileProposal[]): Promise<PublishResult> {
    const plan = await this.planProposals(proposals);
    if (plan.changes.length > 0 || plan.internalChanges.length > 0 || plan.stateChanged) {
      await applyTransaction({
        vault: this.vault,
        actor: "compiler:publish",
        operationId: plan.operationId,
        changes: plan.changes,
        internalChanges: plan.internalChanges,
        objects: plan.objects,
        ...(plan.stateChanged
          ? { nextState: plan.nextState, expectedStateHash: plan.expectedStateHash }
          : {}),
      });
    }
    return plan.result;
  }
}
