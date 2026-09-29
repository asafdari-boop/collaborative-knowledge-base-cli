import { posix } from "node:path";
import { InvalidSourceIdentityError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { sourceIdentity } from "./source-id.js";

export interface ReadableNoteDescriptor {
  id: string;
  title: string;
  folderName: string;
}

export interface PreviousReadableSource {
  path: string;
  title: string;
  aliases: string[];
}

export interface ReadablePathMove {
  sourceId: string;
  from: string;
  to: string;
}

export interface ReadablePathAllocation {
  paths: Map<string, string>;
  aliases: Map<string, string[]>;
  moves: ReadablePathMove[];
}

function comparisonKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

export function sanitizeReadableTitle(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[:/\\\u0000-\u001f\u007f]+/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/(?:\s*-\s*)+$/g, "")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  if (!normalized) return "Untitled Note";
  return [...normalized].slice(0, 180).join("").replace(/[.\s]+$/g, "") || "Untitled Note";
}

function readableFileStem(value: string): string {
  const sanitized = sanitizeReadableTitle(value);
  return sanitized.replace(/\.md$/i, "").replace(/[.\s]+$/g, "") || "Untitled Note";
}

function generatedCandidates(notes: ReadableNoteDescriptor[]): Map<string, string> {
  const titles = new Map<string, ReadableNoteDescriptor[]>();
  for (const candidate of notes) {
    if (!candidate.id) throw new InvalidSourceIdentityError("Apple Note ID cannot be empty");
    const key = comparisonKey(readableFileStem(candidate.title));
    titles.set(key, [...(titles.get(key) ?? []), candidate]);
  }

  const candidates = new Map<string, string>();
  for (const group of titles.values()) {
    if (group.length === 1) {
      const only = group[0]!;
      candidates.set(only.id, `Notes/${readableFileStem(only.title)}.md`);
      continue;
    }
    const titleFolders = new Map<string, ReadableNoteDescriptor[]>();
    for (const candidate of group) {
      const stem = `${readableFileStem(candidate.title)} — ${sanitizeReadableTitle(candidate.folderName)}`;
      const key = comparisonKey(stem);
      titleFolders.set(key, [...(titleFolders.get(key) ?? []), candidate]);
    }
    for (const folderGroup of titleFolders.values()) {
      for (const candidate of folderGroup) {
        const stem = `${readableFileStem(candidate.title)} — ${sanitizeReadableTitle(candidate.folderName)}`;
        const suffix = folderGroup.length > 1 ? ` — ${sha256(candidate.id).slice(0, 8)}` : "";
        candidates.set(candidate.id, `Notes/${stem}${suffix}.md`);
      }
    }
  }
  return candidates;
}

function collisionSafePath(path: string, noteId: string, owners: Map<string, string>): string {
  const key = comparisonKey(path);
  const owner = owners.get(key);
  if (!owner || owner === noteId) return path;
  const extension = posix.extname(path);
  const stem = path.slice(0, -extension.length);
  return `${stem} — ${sha256(noteId).slice(0, 8)}${extension}`;
}

export function allocateReadableNotePaths(
  notes: ReadableNoteDescriptor[],
  previousSources: Readonly<Record<string, PreviousReadableSource>> = {},
): ReadablePathAllocation {
  const ids = new Set<string>();
  for (const candidate of notes) {
    if (ids.has(candidate.id)) throw new InvalidSourceIdentityError(`Duplicate Apple Note ID: ${candidate.id}`);
    ids.add(candidate.id);
  }
  const candidates = generatedCandidates(notes);
  const paths = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  const moves: ReadablePathMove[] = [];
  const owners = new Map<string, string>();

  for (const candidate of [...notes].sort((left, right) => left.id.localeCompare(right.id))) {
    const identity = sourceIdentity(candidate.id);
    const previous = previousSources[identity.noteIdHash];
    let path = candidates.get(candidate.id)!;
    if (previous && !previous.path.startsWith("Notes/")) {
      path = previous.path;
    } else if (
      previous &&
      previous.title === candidate.title &&
      !/\.md\.md$/i.test(previous.path)
    ) {
      path = previous.path;
    }
    path = collisionSafePath(path, candidate.id, owners);
    const key = comparisonKey(path);
    if (owners.has(key) && owners.get(key) !== candidate.id) {
      throw new InvalidSourceIdentityError(`Readable source path collision at ${path}`);
    }
    owners.set(key, candidate.id);
    paths.set(candidate.id, path);

    const noteAliases = [...new Set(previous?.aliases ?? [])];
    if (previous && previous.title !== candidate.title && previous.title && !noteAliases.includes(previous.title)) {
      noteAliases.push(previous.title);
    }
    aliases.set(candidate.id, noteAliases);
    if (previous && previous.path.startsWith("Notes/") && previous.path !== path) {
      moves.push({ sourceId: identity.sourceId, from: previous.path, to: path });
    }
  }

  return { paths, aliases, moves };
}
