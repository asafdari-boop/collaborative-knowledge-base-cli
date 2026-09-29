import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PathEscapeError, SymlinkPathError } from "./errors.js";

function isOutside(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

export function resolveInside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new PathEscapeError(relativePath);
  }

  const rootPath = resolve(root);
  const target = resolve(rootPath, relativePath);
  if (isOutside(relative(rootPath, target))) {
    throw new PathEscapeError(relativePath);
  }
  return target;
}

export async function assertNoSymlinkAncestors(
  root: string,
  target: string,
): Promise<void> {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const relativePath = relative(rootPath, targetPath);
  if (isOutside(relativePath)) {
    throw new PathEscapeError(target);
  }

  const directories = relativePath.split(sep);
  let cursor = rootPath;
  for (const directory of directories) {
    cursor = resolve(cursor, directory);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new SymlinkPathError(cursor);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}
