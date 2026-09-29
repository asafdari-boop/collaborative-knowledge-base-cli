import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CkbConfig } from "../config/schema.js";
import {
  IncompleteCensusError,
  InvalidSourceIdentityError,
  SourceMirrorModifiedError,
} from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { newOperationId } from "../core/ids.js";
import { assertNoSymlinkAncestors, resolveInside } from "../core/paths.js";
import type { ExtractedNote, ExtractionResult } from "../extractors/types.js";
import {
  applyTransaction,
  type TransactionInput,
  type TransactionResult,
  type TransactionChange,
} from "../publishing/transaction.js";
import { applySensitivity, redactSecrets } from "../security/sensitivity.js";
import { loadStateSnapshot } from "../state/state-store.js";
import type { SourceState, WorkspaceState } from "../state/types.js";
import type { UnresolvedReferenceState } from "../state/types.js";
import { normalizeNote, type NormalizedNote } from "./normalize-note.js";
import { sourceWasInCompleteScope } from "./census.js";
import { sourceIdentity } from "./source-id.js";
import { allocateReadableNotePaths } from "./readable-path.js";
import { reconcileFirstClassPage } from "./note-page.js";
import { parseManagedRegions } from "./managed-regions.js";
import { parsePage } from "../pages/frontmatter.js";
import {
  buildSourceReferenceIndex,
  renderExplicitConnections,
  resolveExplicitRelationships,
  type SourceReference,
} from "../graph/explicit-links.js";

export type SourceTransactionApplier = (input: TransactionInput) => Promise<TransactionResult>;

export interface RefreshSourceMirrorInput {
  vault: string;
  extraction: ExtractionResult;
  config: CkbConfig;
  transactionApplier?: SourceTransactionApplier;
  operationId?: string;
}

export interface SourceRefreshResult {
  operationId: string;
  created: number;
  updated: number;
  noops: number;
  attachmentFilesCreated: number;
  redactions: number;
  excluded: number;
  inaccessible: number;
  missing: number;
}

export interface PlannedSourceDocument {
  path: string;
  content: string;
  generatedHash: string;
  compilerEligible: boolean;
}

export interface SourceMirrorRefreshPlan {
  operationId: string;
  changes: TransactionChange[];
  nextState: WorkspaceState;
  expectedStateHash: string;
  sources: PlannedSourceDocument[];
  result: SourceRefreshResult;
  previousConnectionHashes: Record<string, string | undefined>;
}

interface LiveFile {
  content: Buffer;
  hash: string;
}

async function readLiveFile(vault: string, path: string): Promise<LiveFile | null> {
  const absolutePath = resolveInside(vault, path);
  await assertNoSymlinkAncestors(vault, absolutePath);
  const metadata = await stat(absolutePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return null;
  if (!metadata.isFile()) throw new SourceMirrorModifiedError(path);
  const content = await readFile(absolutePath);
  return { content, hash: sha256(content) };
}

function renderUnresolvedReview(
  reference: UnresolvedReferenceState,
  referenceIndex: ReturnType<typeof buildSourceReferenceIndex>,
): string | null {
  const owner = referenceIndex.bySourceId.get(reference.sourceId);
  if (!owner) return null;
  const candidates = reference.candidates
    .map((sourceId) => referenceIndex.bySourceId.get(sourceId))
    .filter((candidate): candidate is SourceReference => candidate !== undefined)
    .map((candidate) => `- [[${candidate.path.replace(/\.md$/, "")}|${candidate.title}]]`);
  return [
    "---",
    `ckb_unresolved_id: ${reference.unresolvedId}`,
    "status: pending",
    "---",
    "# Unresolved note relationship",
    "",
    `- Source: [[${owner.path.replace(/\.md$/, "")}|${owner.title}]]`,
    `- Reference: ${reference.label}`,
    `- Reason: ${reference.status}`,
    `- Origin: ${reference.origin}`,
    "",
    ...(candidates.length ? ["## Candidate targets", "", ...candidates, ""] : []),
    "CKB did not guess a target. Resolve the reference in the source note or curate the desired link in its Connections section.",
    "",
  ].join("\n");
}

function cloneState(state: WorkspaceState): WorkspaceState {
  return structuredClone(state);
}

function safePreviousSource(previous: SourceState, sourcePath: string): SourceState {
  const title = redactSecrets(previous.title).content;
  const metadataWasRedacted = title !== previous.title;
  return {
    ...previous,
    path: metadataWasRedacted ? sourcePath : previous.path,
    title,
    aliases: [...new Set(previous.aliases.map((alias) => redactSecrets(alias).content))],
    account: redactSecrets(previous.account).content,
    folder: redactSecrets(previous.folder).content,
    pathHistory: metadataWasRedacted ? [] : previous.pathHistory,
  };
}

function hasHumanOnlyContent(content: string): boolean {
  const parsed = parsePage(content);
  const regions = parseManagedRegions(parsed.body);
  const local = regions.local.replace(/^## Local additions\s*/i, "").trim();
  return local.length > 0 || /(^|\n)### Curated connections\s*(\n|$)/i.test(regions.connections);
}

async function planObsoleteGeneratedSources(input: {
  vault: string;
  nextState: WorkspaceState;
  sourceChanges: TransactionChange[];
}): Promise<void> {
  const expectedPaths = new Set(Object.values(input.nextState.sources).map((source) => source.path));
  const alreadyDeleted = new Set(input.sourceChanges
    .filter((change) => change.content === null)
    .map((change) => change.path));
  const notesDirectory = join(input.vault, "Notes");
  const entries = await readdir(notesDirectory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = `Notes/${entry.name}`;
    if (expectedPaths.has(path) || alreadyDeleted.has(path)) continue;
    const live = await readLiveFile(input.vault, path);
    if (!live) continue;
    let parsed: ReturnType<typeof parsePage>;
    try {
      parsed = parsePage(live.content.toString("utf8"));
    } catch {
      continue;
    }
    const appleNoteId = parsed.attributes.appleNoteId;
    const source = parsed.attributes.source;
    if (
      typeof appleNoteId !== "string"
      || typeof source !== "string"
      || !source.startsWith("applenotes://")
    ) continue;
    const current = input.nextState.sources[sourceIdentity(appleNoteId).noteIdHash];
    if (!current || current.path === path) continue;
    try {
      if (hasHumanOnlyContent(live.content.toString("utf8"))) {
        throw new SourceMirrorModifiedError(path);
      }
    } catch (error: unknown) {
      if (error instanceof SourceMirrorModifiedError) throw error;
      continue;
    }
    input.sourceChanges.push({ path, expectedHash: live.hash, content: null });
  }
}

function assignSourcePaths(
  state: WorkspaceState,
  notes: ExtractedNote[],
): Map<string, string> {
  const allocated = allocateReadableNotePaths(
    notes.map((note) => ({ id: note.id, title: note.title, folderName: note.folderName })),
    state.sources,
  ).paths;
  const pathOwners = new Map(
    Object.values(state.sources).map((source) => [source.path, source.noteIdHash]),
  );
  const result = new Map<string, string>();
  for (const noteId of notes.map((note) => note.id)) {
    const identity = sourceIdentity(noteId);
    const path = allocated.get(noteId);
    if (!path) throw new InvalidSourceIdentityError(`No source path allocated for ${noteId}`);
    const owner = pathOwners.get(path);
    if (owner && owner !== identity.noteIdHash) {
      throw new InvalidSourceIdentityError(`Source path collision at ${path}`);
    }
    pathOwners.set(path, identity.noteIdHash);
    result.set(noteId, path);
  }
  return result;
}

async function assertSourceMirror(
  vault: string,
  path: string,
  previous: SourceState | undefined,
): Promise<LiveFile | null> {
  const live = await readLiveFile(vault, path);
  if (!previous) {
    if (live !== null) throw new SourceMirrorModifiedError(path);
    return null;
  }
  if (!previous.generatedHash || live?.hash !== previous.generatedHash) {
    throw new SourceMirrorModifiedError(path);
  }
  return live;
}

function addAttachmentChange(
  changes: Map<string, TransactionChange>,
  path: string,
  expectedHash: string | null,
  content: Buffer,
): boolean {
  const existing = changes.get(path);
  if (existing) {
    if (
      existing.expectedHash !== expectedHash ||
      existing.content === null ||
      sha256(existing.content) !== sha256(content)
    ) {
      throw new InvalidSourceIdentityError(`Conflicting attachment plans for ${path}`);
    }
    return false;
  }
  changes.set(path, { path, expectedHash, content });
  return true;
}

export async function planSourceMirrorRefresh(
  input: RefreshSourceMirrorInput,
): Promise<SourceMirrorRefreshPlan> {
  if (!input.extraction.census.complete) {
    throw new IncompleteCensusError("Refusing to publish an incomplete Apple Notes census");
  }
  const operationId = input.operationId ?? newOperationId();
  const stateSnapshot = await loadStateSnapshot(input.vault);
  const nextState = cloneState(stateSnapshot.state);
  const sensitivityResults = input.extraction.census.notes.map((note) =>
    applySensitivity(note, input.config.sensitivity)
  );
  const extractedNotes = sensitivityResults.map((result) => result.note);
  const previousForAllocation = Object.fromEntries(Object.entries(stateSnapshot.state.sources).map(
    ([hash, previous]) => [hash, {
      ...previous,
      title: redactSecrets(previous.title).content === previous.title
        ? previous.title
        : "",
      aliases: previous.aliases.map((alias) => redactSecrets(alias).content),
    }],
  ));
  const sourcePaths = assignSourcePaths({ ...stateSnapshot.state, sources: previousForAllocation }, extractedNotes);
  const references: SourceReference[] = extractedNotes.map((note) => {
    const identity = sourceIdentity(note.id);
    const previous = stateSnapshot.state.sources[identity.noteIdHash];
    const safePreviousTitle = previous ? redactSecrets(previous.title).content : undefined;
    const aliases = [...new Set([
      ...(previous?.aliases ?? []).map((alias) => redactSecrets(alias).content),
      ...(safePreviousTitle && safePreviousTitle !== note.title ? [safePreviousTitle] : []),
    ])];
    return {
      sourceId: identity.sourceId,
      noteIdHash: identity.noteIdHash,
      title: note.title,
      aliases,
      path: sourcePaths.get(note.id)!,
    };
  });
  const referenceIndex = buildSourceReferenceIndex(references);
  const explicitByNoteId = new Map<string, ReturnType<typeof resolveExplicitRelationships>>();
  for (const note of extractedNotes) {
    const source = references.find((candidate) => candidate.noteIdHash === sourceIdentity(note.id).noteIdHash)!;
    explicitByNoteId.set(note.id, resolveExplicitRelationships({
      source,
      markdown: note.markdown ?? "",
      internalLinks: note.internalLinks,
      index: referenceIndex,
    }));
  }
  const currentSourceIds = new Set(references.map((source) => source.sourceId));
  const relationships = Object.values(stateSnapshot.state.relationships)
    .filter((relationship) => relationship.origin !== "explicit" || !currentSourceIds.has(relationship.fromId));
  for (const resolved of explicitByNoteId.values()) relationships.push(...resolved.relationships);
  nextState.relationships = Object.fromEntries(
    relationships.map((relationship) => [relationship.relationshipId, relationship]),
  );
  const unresolvedReferences: UnresolvedReferenceState[] = [];
  for (const resolved of explicitByNoteId.values()) {
    for (const unresolved of resolved.unresolved) {
      const digest = sha256([
        unresolved.sourceId,
        unresolved.status,
        unresolved.origin,
        unresolved.label,
        ...unresolved.candidates,
      ].join("\u0000"));
      unresolvedReferences.push({
        unresolvedId: `unresolved:${digest}`,
        ...unresolved,
        reviewPath: `Reviews/Links/${digest.slice(0, 16)}.md`,
      });
    }
  }
  nextState.unresolvedReferences = Object.fromEntries([
    ...Object.values(stateSnapshot.state.unresolvedReferences)
      .filter((reference) => !currentSourceIds.has(reference.sourceId)),
    ...unresolvedReferences,
  ].map((reference) => [reference.unresolvedId, reference]));
  const currentHashes = new Set<string>();
  const sourceChanges: TransactionChange[] = [];
  const reviewChanges: TransactionChange[] = [];
  const attachmentChanges = new Map<string, TransactionChange>();
  const sources: PlannedSourceDocument[] = [];
  const previousConnectionHashes: Record<string, string | undefined> = {};
  let created = 0;
  let updated = 0;
  let noops = 0;
  let attachmentFilesCreated = 0;
  const redactions = sensitivityResults.reduce((total, result) => total + result.redactions, 0);
  let excluded = 0;
  let inaccessible = 0;

  for (const reference of unresolvedReferences) {
    const reviewContent = renderUnresolvedReview(reference, referenceIndex)!;
    const liveReview = await readLiveFile(input.vault, reference.reviewPath);
    reviewChanges.push({
      path: reference.reviewPath,
      expectedHash: liveReview?.hash ?? null,
      content: liveReview?.content ?? reviewContent,
    });
  }
  const currentUnresolvedIds = new Set(unresolvedReferences.map((reference) => reference.unresolvedId));
  for (const previousReference of Object.values(stateSnapshot.state.unresolvedReferences)) {
    if (!currentSourceIds.has(previousReference.sourceId) ||
        currentUnresolvedIds.has(previousReference.unresolvedId)) continue;
    const liveReview = await readLiveFile(input.vault, previousReference.reviewPath);
    const generated = renderUnresolvedReview(previousReference, referenceIndex);
    if (liveReview && generated !== null && liveReview.content.equals(Buffer.from(generated))) {
      reviewChanges.push({
        path: previousReference.reviewPath,
        expectedHash: liveReview.hash,
        content: null,
      });
    }
  }

  for (const extracted of [...extractedNotes].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const identity = sourceIdentity(extracted.id);
    currentHashes.add(identity.noteIdHash);
    const previous = stateSnapshot.state.sources[identity.noteIdHash];
    previousConnectionHashes[identity.sourceId] = previous?.connectionsRegionHash;
    const sourcePath = sourcePaths.get(extracted.id);
    if (!sourcePath) throw new InvalidSourceIdentityError(`No source path for ${extracted.id}`);
    const safePrevious = previous ? safePreviousSource(previous, sourcePath) : undefined;
    const normalized: NormalizedNote = await normalizeNote({
      note: extracted,
      sourcePath,
      sourcePaths,
      exportRoot: input.extraction.exportRoot,
      capturedAt: input.extraction.census.completedAt,
      attachmentMaxBytes: input.config.attachmentMaxBytes,
      connectionsMarkdown: renderExplicitConnections(
        identity.sourceId,
        relationships,
        referenceIndex,
      ),
      ...(safePrevious ? { previous: safePrevious } : {}),
    });
    if (normalized.state.censusStatus === "excluded") excluded += 1;
    if (normalized.state.censusStatus === "inaccessible") inaccessible += 1;

    const livePath = previous?.path ?? sourcePath;
    let live: LiveFile | null;
    let publishedContent = normalized.content;
    let publishedState = normalized.state;
    if (!previous) {
      live = await assertSourceMirror(input.vault, livePath, previous);
    } else {
      live = await readLiveFile(input.vault, livePath);
      if (!previous.generatedHash || live === null) throw new SourceMirrorModifiedError(livePath);
      if (previous.upstreamRegionHash && previous.connectionsRegionHash) {
        try {
          const reconciled = reconcileFirstClassPage({
            previous,
            liveContent: live.content.toString("utf8"),
            nextContent: normalized.content,
          });
          if (reconciled.status === "conflict") throw new SourceMirrorModifiedError(livePath);
          publishedContent = reconciled.content;
          publishedState = {
            ...normalized.state,
            generatedHash: sha256(publishedContent),
            upstreamRegionHash: reconciled.status === "local_divergence"
              ? previous.upstreamRegionHash
              : sha256(reconciled.regions.upstream),
            connectionsRegionHash: reconciled.generatedConnectionsHash,
            localRegionHash: sha256(reconciled.regions.local),
            syncStatus: reconciled.status,
          };
        } catch (error: unknown) {
          if (error instanceof SourceMirrorModifiedError) throw error;
          throw new SourceMirrorModifiedError(livePath);
        }
      } else if (live.hash !== previous.generatedHash) {
        throw new SourceMirrorModifiedError(livePath);
      }
    }
    const nextHash = sha256(publishedContent);
    if (previous && previous.path !== sourcePath) {
      if (await readLiveFile(input.vault, sourcePath)) {
        throw new SourceMirrorModifiedError(sourcePath);
      }
      sourceChanges.push(
        { path: previous.path, expectedHash: live?.hash ?? null, content: null },
        { path: sourcePath, expectedHash: null, content: publishedContent },
      );
      updated += 1;
    } else {
      sourceChanges.push({
        path: sourcePath,
        expectedHash: live?.hash ?? null,
        content: publishedContent,
      });
      if (live === null) created += 1;
      else if (live.hash === nextHash) noops += 1;
      else updated += 1;
    }

    for (const attachment of normalized.attachments) {
      const liveAttachment = await readLiveFile(input.vault, attachment.targetPath);
      if (liveAttachment !== null && liveAttachment.hash !== attachment.hash) {
        throw new SourceMirrorModifiedError(attachment.targetPath);
      }
      const added = addAttachmentChange(
        attachmentChanges,
        attachment.targetPath,
        liveAttachment?.hash ?? null,
        attachment.content,
      );
      if (added && liveAttachment === null) attachmentFilesCreated += 1;
    }

    nextState.sources[identity.noteIdHash] = {
      ...publishedState,
      lastOperationId: operationId,
    };
    sources.push({
      path: sourcePath,
      content: publishedContent,
      generatedHash: nextHash,
      compilerEligible: normalized.state.censusStatus === "present",
    });
  }

  let missing = 0;
  for (const previous of Object.values(stateSnapshot.state.sources)) {
    if (currentHashes.has(previous.noteIdHash)) continue;
    if (!sourceWasInCompleteScope(previous, input.extraction.census)) continue;
    const live = await assertSourceMirror(input.vault, previous.path, previous);
    if (live === null) throw new SourceMirrorModifiedError(previous.path);
    const tombstoneObjectHash = sha256(live.content);
    nextState.sources[previous.noteIdHash] = {
      ...previous,
      censusStatus: "missing_upstream",
      missingCensusCount: previous.missingCensusCount + 1,
      tombstoneObjectHash,
      lastOperationId: operationId,
    };
    sourceChanges.push({
      path: previous.path,
      expectedHash: live.hash,
      content: live.content,
    });
    noops += 1;
    missing += 1;
  }

  await planObsoleteGeneratedSources({
    vault: input.vault,
    nextState,
    sourceChanges,
  });

  const result: SourceRefreshResult = {
    operationId,
    created,
    updated,
    noops,
    attachmentFilesCreated,
    redactions,
    excluded,
    inaccessible,
    missing,
  };
  return {
    operationId,
    changes: [...sourceChanges, ...attachmentChanges.values(), ...reviewChanges],
    nextState,
    expectedStateHash: stateSnapshot.hash,
    sources,
    result,
    previousConnectionHashes,
  };
}

export async function refreshSourceMirror(
  input: RefreshSourceMirrorInput,
): Promise<SourceRefreshResult> {
  const plan = await planSourceMirrorRefresh(input);
  const transactionApplier = input.transactionApplier ?? applyTransaction;
  await transactionApplier({
    vault: input.vault,
    actor: "source:apple-notes-refresh",
    operationId: plan.operationId,
    changes: plan.changes,
    nextState: plan.nextState,
    expectedStateHash: plan.expectedStateHash,
  });
  return plan.result;
}
