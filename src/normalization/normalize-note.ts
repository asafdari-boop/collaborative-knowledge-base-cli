import { InvalidSourceIdentityError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import type { ExtractedNote } from "../extractors/types.js";
import type { SourceState } from "../state/types.js";
import { planAttachments, type AttachmentPlan } from "./attachments.js";
import { renderSource, type SourceFrontmatter } from "./frontmatter.js";
import {
  appendUnlinkedAttachmentReferences,
  rewriteAttachmentLinks,
  rewriteInternalNoteLinks,
} from "./internal-links.js";
import { sourceIdentity } from "./source-id.js";
import { renderManagedRegions } from "./managed-regions.js";


export interface NormalizeNoteInput {
  note: ExtractedNote;
  sourcePath: string;
  sourcePaths: ReadonlyMap<string, string>;
  exportRoot: string;
  capturedAt: string;
  attachmentMaxBytes: number;
  connectionsMarkdown?: string;
  previous?: SourceState;
}

export interface NormalizedNote {
  path: string;
  content: string;
  contentHash: string;
  attachments: AttachmentPlan[];
  state: SourceState;
}

function normalizeBody(body: string): string {
  const normalized = body
    .replace(/\r\n?/g, "\n")
    .replace(/\[\[(\d+)\]\](\(https?:\/\/[^\s)]+(?:\s+[^)]*)?\))/g, "[$1]$2");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function sameHashes(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((hash, index) => hash === right[index]);
}

export async function normalizeNote(input: NormalizeNoteInput): Promise<NormalizedNote> {
  const previous = input.previous;
  const identity = sourceIdentity(input.note.id);
  if (input.sourcePaths.get(input.note.id) !== input.sourcePath) {
    throw new InvalidSourceIdentityError("The assigned source path does not match the note map");
  }
  if (previous && previous.noteIdHash !== identity.noteIdHash) {
    throw new InvalidSourceIdentityError("Previous source state belongs to a different note");
  }

  const withheldReason =
    input.note.sensitivity === "excluded"
      ? "excluded"
      : input.note.accessibility !== "readable"
        ? "inaccessible"
        : undefined;
  const attachments =
    withheldReason === undefined
      ? await planAttachments(input.note.attachments, input.exportRoot, input.attachmentMaxBytes)
      : [];

  let fullBody: string;
  if (withheldReason === "excluded") {
    fullBody = "> Content withheld by the local sensitivity policy.\n";
  } else if (withheldReason === "inaccessible") {
    fullBody = "> Note content is unavailable or locked in Apple Notes.\n";
  } else {
    const linked = rewriteInternalNoteLinks(
      normalizeBody(input.note.markdown ?? ""),
      input.note.internalLinks,
      input.sourcePaths,
    );
    const rewrittenAttachments = rewriteAttachmentLinks(
      linked,
      input.note.exportedRelativePath ?? "",
      input.sourcePath,
      attachments,
    );
    fullBody = appendUnlinkedAttachmentReferences(
      rewrittenAttachments,
      input.sourcePath,
      attachments,
    );
  }
  fullBody = normalizeBody(fullBody);
  const contentHash = sha256(fullBody);
  const attachmentHashes = attachments.map((attachment) => attachment.hash).sort();
  const aliases = [...(previous?.aliases ?? [])];
  if (
    previous &&
    previous.title !== input.note.title &&
    previous.title &&
    !aliases.includes(previous.title)
  ) {
    aliases.push(previous.title);
  }
  const normalizedAliases = aliases.filter((alias) => alias !== input.note.title);
  const unchanged =
    previous !== undefined &&
    previous.title === input.note.title &&
    previous.account === input.note.accountName &&
    previous.folder === input.note.folderName &&
    previous.createdAt === input.note.createdAt &&
    previous.modifiedAt === input.note.modifiedAt &&
    previous.contentHash === contentHash &&
    sameHashes(previous.attachmentHashes, attachmentHashes) &&
    previous.censusStatus ===
      (withheldReason === "excluded"
        ? "excluded"
        : withheldReason === "inaccessible"
          ? "inaccessible"
          : "present");
  const ingestedAt = unchanged && previous?.ingestedAt
    ? previous.ingestedAt
    : input.capturedAt;
  const frontmatter: SourceFrontmatter = {
    title: input.note.title,
    source: `applenotes://${encodeURIComponent(input.note.id)}`,
    sourceType: "file",
    ingestedAt,
    appleNoteId: input.note.id,
    createdAt: input.note.createdAt,
    modifiedAt: input.note.modifiedAt,
    account: input.note.accountName,
    folder: input.note.folderName,
    contentHash,
    attachmentHashes,
    aliases: normalizedAliases,
    ...(withheldReason
      ? { withheld: true as const, withheldReason }
      : {}),
  };
  const connections = input.connectionsMarkdown ?? "## Connections\n\n";
  const local = "## Local additions\n\n";
  const body = renderManagedRegions({ upstream: fullBody, connections, local });
  const content = renderSource(frontmatter, body);
  const state: SourceState = {
    sourceId: identity.sourceId,
    noteIdHash: identity.noteIdHash,
    path: input.sourcePath,
    title: input.note.title,
    aliases: normalizedAliases,
    account: input.note.accountName,
    folder: input.note.folderName,
    createdAt: input.note.createdAt,
    modifiedAt: input.note.modifiedAt,
    ingestedAt,
    contentHash,
    generatedHash: sha256(content),
    attachmentHashes,
    censusStatus:
      withheldReason === "excluded"
        ? "excluded"
        : withheldReason === "inaccessible"
          ? "inaccessible"
          : "present",
    missingCensusCount: 0,
    lastSeenAt: input.capturedAt,
    upstreamHash: contentHash,
    upstreamRegionHash: sha256(fullBody),
    connectionsRegionHash: sha256(connections),
    localRegionHash: sha256(local),
    ...(previous?.primaryMoc ? { primaryMoc: previous.primaryMoc } : {}),
    secondaryMocs: previous?.secondaryMocs ?? [],
    syncStatus: "clean",
    pathHistory: previous && previous.path !== input.sourcePath
      ? [...new Set([...(previous.pathHistory ?? []), previous.path])]
      : [...(previous?.pathHistory ?? [])],
  };
  return { path: input.sourcePath, content, contentHash, attachments, state };
}
