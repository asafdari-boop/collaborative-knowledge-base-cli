import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RecoveryConflictError, WorkspaceLockedError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { newOperationId } from "../core/ids.js";
import { assertNoSymlinkAncestors, resolveInside } from "../core/paths.js";
import { getObjectBuffer } from "../state/object-store.js";
import { WorkspaceStateSchema } from "../state/types.js";
import { appendJournal, readJournal } from "./journal.js";
import { acquireWorkspaceLock } from "./lock.js";
import {
  listRecoveryRecords,
  removeRecoveryRecord,
  type RecoveryRecord,
} from "./recovery-store.js";

export interface RecoveryResult {
  recovered: string[];
  completedCleanup: string[];
  staleLockCleared: boolean;
}

async function readBuffer(path: string): Promise<Buffer | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw new RecoveryConflictError(path);
    return readFile(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function removeFile(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

async function replaceWithBuffer(path: string, content: Buffer): Promise<void> {
  const temporary = `${path}.recovery-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function backupPath(path: string, operationId: string): string {
  return `${path}.ckb-${operationId.slice("op:".length)}.bak`;
}

async function restoreChange(vault: string, record: RecoveryRecord, index: number): Promise<void> {
  const change = record.changes[index];
  if (!change) return;
  const target = resolveInside(vault, change.path);
  await assertNoSymlinkAncestors(vault, target);
  const backup = backupPath(target, record.operationId);
  const displaced = await readBuffer(backup);
  if (displaced !== null) {
    const current = await readBuffer(target);
    const currentHash = current === null ? null : sha256(current);
    if (currentHash !== null && currentHash !== change.newHash) {
      throw new RecoveryConflictError(change.path);
    }
    await removeFile(target);
    await rename(backup, target);
    return;
  }

  const current = await readBuffer(target);
  const currentHash = current === null ? null : sha256(current);
  if (currentHash === change.previousHash) return;
  if (currentHash !== change.newHash) throw new RecoveryConflictError(change.path);
  if (change.previousObjectHash === null) {
    await removeFile(target);
    return;
  }
  await replaceWithBuffer(target, await getObjectBuffer(vault, change.previousObjectHash));
}

async function restoreState(vault: string, record: RecoveryRecord): Promise<void> {
  if (!record.state) return;
  const statePath = join(vault, ".ckb/state.json");
  const current = await readFile(statePath);
  const currentHash = sha256(current);
  if (currentHash === record.state.previousHash) return;
  if (currentHash !== record.state.newHash) throw new RecoveryConflictError(".ckb/state.json");
  const previous = await getObjectBuffer(vault, record.state.previousObjectHash);
  WorkspaceStateSchema.parse(JSON.parse(previous.toString("utf8")) as unknown);
  await replaceWithBuffer(statePath, previous);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function clearStaleLock(vault: string): Promise<boolean> {
  const path = join(vault, ".ckb/lock");
  const raw = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return false;
  let pid: number;
  try {
    const decoded = JSON.parse(raw) as { pid?: unknown };
    if (!Number.isSafeInteger(decoded.pid) || (decoded.pid as number) <= 0) {
      throw new Error("invalid lock pid");
    }
    pid = decoded.pid as number;
  } catch {
    throw new WorkspaceLockedError();
  }
  if (processIsAlive(pid)) throw new WorkspaceLockedError();
  await unlink(path);
  return true;
}

async function cleanupCompleted(vault: string, record: RecoveryRecord): Promise<void> {
  for (const change of record.changes) {
    const backup = backupPath(resolveInside(vault, change.path), record.operationId);
    const content = await readBuffer(backup);
    if (content !== null && sha256(content) !== change.previousHash) {
      throw new RecoveryConflictError(change.path);
    }
    await removeFile(backup);
  }
  await removeRecoveryRecord(vault, record.operationId);
}

export async function recoverWorkspace(vault: string): Promise<RecoveryResult> {
  const records = await listRecoveryRecords(vault);
  const staleLockCleared = await clearStaleLock(vault);
  if (records.length === 0) {
    return { recovered: [], completedCleanup: [], staleLockCleared };
  }
  const lock = await acquireWorkspaceLock(vault, newOperationId());
  const recovered: string[] = [];
  const completedCleanup: string[] = [];
  try {
    const journal = await readJournal(vault);
    for (const record of records) {
      const completed = journal.some(
        (event) => event.operationId === record.operationId && event.result === "applied",
      );
      if (completed) {
        await cleanupCompleted(vault, record);
        completedCleanup.push(record.operationId);
        continue;
      }
      for (let index = record.changes.length - 1; index >= 0; index -= 1) {
        await restoreChange(vault, record, index);
      }
      await restoreState(vault, record);
      await appendJournal(vault, {
        schemaVersion: 1,
        operationId: record.operationId,
        actor: "recovery",
        timestamp: new Date().toISOString(),
        result: "recovered",
        conflictCount: 0,
        changes: record.changes.map((change) => ({
          path: change.path,
          previousHash: change.newHash,
          newHash: change.previousHash,
          previousObjectHash: change.previousObjectHash,
        })),
      });
      await cleanupCompleted(vault, record);
      recovered.push(record.operationId);
    }
    return { recovered, completedCleanup, staleLockCleared };
  } finally {
    await lock.release();
  }
}
