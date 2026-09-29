import { cp, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { InvalidWorkspaceError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";

export interface BackupManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  schemaVersion: 1;
  digest: string;
  entries: BackupManifestEntry[];
}

async function requireDirectory(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    throw new InvalidWorkspaceError(
      `Unable to inspect backup source ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (metadata.isSymbolicLink()) throw new InvalidWorkspaceError(`Backup root is a symlink: ${path}`);
  if (!metadata.isDirectory()) throw new InvalidWorkspaceError(`Backup root is not a directory: ${path}`);
}

async function entriesFor(root: string): Promise<BackupManifestEntry[]> {
  const entries: BackupManifestEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new InvalidWorkspaceError(`Backup tree contains a symlink: ${path}`);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const content = await readFile(absolute);
        entries.push({ path, size: content.length, sha256: sha256(content) });
      } else {
        throw new InvalidWorkspaceError(`Backup tree contains an unsupported entry: ${path}`);
      }
    }
  };
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export class BackupService {
  public async manifest(rootPath: string): Promise<BackupManifest> {
    const root = resolve(rootPath);
    await requireDirectory(root);
    const entries = await entriesFor(root);
    return {
      schemaVersion: 1,
      digest: sha256(JSON.stringify(entries)),
      entries,
    };
  }

  public async verify(root: string, expected: BackupManifest): Promise<boolean> {
    const actual = await this.manifest(root);
    return actual.digest === expected.digest && JSON.stringify(actual.entries) === JSON.stringify(expected.entries);
  }

  public async copyVerified(input: { source: string; destination: string }): Promise<{
    source: string;
    destination: string;
    manifest: BackupManifest;
  }> {
    const source = resolve(input.source);
    const destination = resolve(input.destination);
    const manifest = await this.manifest(source);
    try {
      await lstat(destination);
      throw new InvalidWorkspaceError(`Backup destination already exists: ${destination}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    if (!(await this.verify(destination, manifest))) {
      throw new InvalidWorkspaceError(`Backup verification failed: ${destination}`);
    }
    return { source, destination, manifest };
  }
}
