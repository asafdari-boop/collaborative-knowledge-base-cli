import { open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceLockedError } from "../core/errors.js";
import { newOperationId } from "../core/ids.js";

interface LockFile {
  pid: number;
  acquiredAt: string;
  operationId: string;
}

export interface WorkspaceLock {
  operationId: string;
  release(): Promise<void>;
}

async function closeAndRemove(handle: FileHandle, path: string): Promise<void> {
  await handle.close();
  await unlink(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

export async function acquireWorkspaceLock(
  vault: string,
  suppliedOperationId?: string,
): Promise<WorkspaceLock> {
  const lockPath = join(vault, ".ckb/lock");
  const operationId = suppliedOperationId ?? newOperationId();
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceLockedError();
    }
    throw error;
  }

  const record: LockFile = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    operationId,
  };
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } catch (error: unknown) {
    await closeAndRemove(handle, lockPath);
    throw error;
  }

  let released = false;
  return {
    operationId,
    async release() {
      if (released) return;
      released = true;
      let ownsLock = false;
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockFile>;
        ownsLock = current.operationId === operationId;
      } finally {
        await handle.close();
      }
      if (ownsLock) {
        await unlink(lockPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    },
  };
}
