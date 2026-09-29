import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CkbConfig } from "../config/schema.js";
import type { NotesExtractor } from "../extractors/types.js";
import { planSourceMirrorRefresh } from "../normalization/source-plan.js";
import { loadState } from "../state/state-store.js";
import type { SourceState, WorkspaceState } from "../state/types.js";

export type UpstreamChangeField =
  | "content"
  | "attachments"
  | "title"
  | "account"
  | "folder"
  | "createdAt"
  | "modifiedAt"
  | "status";

export interface UpstreamChange {
  kind: "new" | "changed" | "missing";
  sourceId: string;
  title: string;
  path: string;
  changedFields: UpstreamChangeField[];
  previousContentHash: string | null;
  currentContentHash: string | null;
}

export interface UpstreamDiffSummary {
  new: number;
  changed: number;
  missing: number;
  unchanged: number;
}

export interface UpstreamDiffClassification {
  summary: UpstreamDiffSummary;
  changes: UpstreamChange[];
}

export interface UpstreamDiffResult extends UpstreamDiffClassification {
  capturedAt: string;
  source: { mode: "live" | "copied-database" };
  warnings: { code: string; message: string }[];
}

export interface UpstreamDiffOptions {
  vault: string;
  config: CkbConfig;
  signal?: AbortSignal;
}

export interface UpstreamDiffServiceDependencies {
  extractor: NotesExtractor;
}

function sameHashSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((hash, index) => hash === rightSorted[index]);
}

function changedFields(previous: SourceState, proposed: SourceState): UpstreamChangeField[] {
  const fields: UpstreamChangeField[] = [];
  if (previous.contentHash !== proposed.contentHash) fields.push("content");
  if (!sameHashSet(previous.attachmentHashes, proposed.attachmentHashes)) {
    fields.push("attachments");
  }
  if (previous.title !== proposed.title) fields.push("title");
  if (previous.account !== proposed.account) fields.push("account");
  if (previous.folder !== proposed.folder) fields.push("folder");
  if (previous.createdAt !== proposed.createdAt) fields.push("createdAt");
  if (previous.modifiedAt !== proposed.modifiedAt) fields.push("modifiedAt");
  if (previous.censusStatus !== proposed.censusStatus) fields.push("status");
  return fields;
}

function sortableChange(left: UpstreamChange, right: UpstreamChange): number {
  return left.title.localeCompare(right.title) ||
    left.path.localeCompare(right.path) ||
    left.sourceId.localeCompare(right.sourceId);
}

export function classifyUpstreamChanges(
  previous: WorkspaceState,
  proposed: WorkspaceState,
): UpstreamDiffClassification {
  const summary: UpstreamDiffSummary = { new: 0, changed: 0, missing: 0, unchanged: 0 };
  const changes: UpstreamChange[] = [];
  const keys = new Set([...Object.keys(previous.sources), ...Object.keys(proposed.sources)]);

  for (const key of keys) {
    const before = previous.sources[key];
    const after = proposed.sources[key];
    if (after?.censusStatus === "missing_upstream" && before?.censusStatus === "missing_upstream") {
      summary.unchanged += 1;
      continue;
    }
    if (!after || after.censusStatus === "missing_upstream") {
      const source = after ?? before;
      if (!source) continue;
      summary.missing += 1;
      changes.push({
        kind: "missing",
        sourceId: source.sourceId,
        title: source.title,
        path: source.path,
        changedFields: ["status"],
        previousContentHash: before?.contentHash ?? null,
        currentContentHash: null,
      });
      continue;
    }
    if (!before) {
      summary.new += 1;
      changes.push({
        kind: "new",
        sourceId: after.sourceId,
        title: after.title,
        path: after.path,
        changedFields: [],
        previousContentHash: null,
        currentContentHash: after.contentHash ?? null,
      });
      continue;
    }

    const fields = changedFields(before, after);
    if (fields.length === 0) {
      summary.unchanged += 1;
      continue;
    }
    summary.changed += 1;
    changes.push({
      kind: "changed",
      sourceId: after.sourceId,
      title: after.title,
      path: after.path,
      changedFields: fields,
      previousContentHash: before.contentHash ?? null,
      currentContentHash: after.contentHash ?? null,
    });
  }

  changes.sort(sortableChange);
  return { summary, changes };
}

export class UpstreamDiffService {
  public constructor(private readonly dependencies: UpstreamDiffServiceDependencies) {}

  public async diff(options: UpstreamDiffOptions): Promise<UpstreamDiffResult> {
    const vault = resolve(options.vault);
    const temporary = await mkdtemp(join(tmpdir(), "ckb-upstream-diff-"));
    try {
      const previous = await loadState(vault);
      const extraction = await this.dependencies.extractor.extract({
        stagingDirectory: temporary,
        accountAllowlist: options.config.extractor.accountAllowlist,
        folderAllowlist: options.config.extractor.folderAllowlist,
        noteIdAllowlist: options.config.extractor.noteIdAllowlist,
        maximumNoteCount: options.config.extractor.maximumNoteCount,
        timeoutMs: options.config.extractor.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const plan = await planSourceMirrorRefresh({
        vault,
        extraction,
        config: options.config,
      });
      return {
        capturedAt: extraction.census.completedAt,
        source: {
          mode: options.config.extractor.databasePath ? "copied-database" : "live",
        },
        ...classifyUpstreamChanges(previous, plan.nextState),
        warnings: extraction.census.warnings.map(({ code, message }) => ({ code, message })),
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
