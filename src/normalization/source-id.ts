import { InvalidSourceIdentityError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_DIRECTORY = "Sources/Apple Notes";

export interface SourceIdentity {
  noteIdHash: string;
  sourceId: string;
  path: string;
}

export interface AllocateSourcePathOptions {
  hashNoteId?: (noteId: string) => string;
}

function validateHash(noteId: string, hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new InvalidSourceIdentityError(`Invalid SHA-256 identity for note ${noteId}`);
  }
}

export function sourceIdentity(noteId: string): SourceIdentity {
  if (!noteId) throw new InvalidSourceIdentityError("Apple Note ID cannot be empty");
  const noteIdHash = sha256(noteId);
  return {
    noteIdHash,
    sourceId: `apple-note:${noteIdHash}`,
    path: `${SOURCE_DIRECTORY}/apple-note-${noteIdHash.slice(0, 16)}.md`,
  };
}

export function allocateSourcePaths(
  noteIds: Iterable<string>,
  options: AllocateSourcePathOptions = {},
): Map<string, string> {
  const hashNoteId = options.hashNoteId ?? sha256;
  const identities = new Map<string, string>();
  const fullHashes = new Set<string>();
  const prefixes = new Map<string, string[]>();

  for (const noteId of noteIds) {
    if (!noteId) throw new InvalidSourceIdentityError("Apple Note ID cannot be empty");
    if (identities.has(noteId)) {
      throw new InvalidSourceIdentityError(`Duplicate Apple Note ID: ${noteId}`);
    }
    const hash = hashNoteId(noteId);
    validateHash(noteId, hash);
    if (fullHashes.has(hash)) {
      throw new InvalidSourceIdentityError("Two Apple Note IDs produced the same full hash");
    }
    fullHashes.add(hash);
    identities.set(noteId, hash);
    const prefix = hash.slice(0, 16);
    prefixes.set(prefix, [...(prefixes.get(prefix) ?? []), noteId]);
  }

  const paths = new Map<string, string>();
  for (const [noteId, hash] of identities) {
    const collides = (prefixes.get(hash.slice(0, 16))?.length ?? 0) > 1;
    paths.set(
      noteId,
      `${SOURCE_DIRECTORY}/apple-note-${collides ? hash : hash.slice(0, 16)}.md`,
    );
  }
  return paths;
}
