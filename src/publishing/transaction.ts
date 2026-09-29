import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  InvalidTransactionError,
  RecoveryConflictError,
  StaleRevisionError,
  StaleStateError,
  SymlinkPathError,
  TransactionRollbackError,
} from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { newOperationId } from "../core/ids.js";
import { assertNoSymlinkAncestors, resolveInside } from "../core/paths.js";
import { getObjectBuffer, putObject } from "../state/object-store.js";
import { loadStateSnapshot, saveState, serializeState } from "../state/state-store.js";
import { WorkspaceStateSchema, type WorkspaceState } from "../state/types.js";
import { appendJournal, readJournal, type JournalEvent } from "./journal.js";
import { acquireWorkspaceLock } from "./lock.js";
import type { WorkspaceLock } from "./lock.js";
import {
  removeRecoveryRecord,
  writeRecoveryRecord,
  type RecoveryRecord,
} from "./recovery-store.js";

const hashPattern = /^[0-9a-f]{64}$/;

export interface TransactionChange {
  path: string;
  expectedHash: string | null;
  content: string | Buffer | null;
}

export interface TransactionInput {
  vault: string;
  actor: string;
  operationId?: string;
  changes: TransactionChange[];
  internalChanges?: TransactionChange[];
  objects?: Array<string | Buffer>;
  lock?: WorkspaceLock;
  nextState?: WorkspaceState;
  expectedStateHash?: string;
}

export interface TransactionResult {
  operationId: string;
  result: "applied";
  changes: JournalEvent["changes"];
}

export type FailureStage =
  | "before_replace"
  | "after_displace"
  | "after_rename"
  | "after_state_save"
  | "after_commit";

export interface TransactionApplierOptions {
  failureInjector?: (stage: FailureStage, index: number) => void;
}

interface PreparedChange extends TransactionChange {
  absolutePath: string;
  previousContent: Buffer | null;
  previousHash: string | null;
  previousObjectHash: string | null;
  newHash: string | null;
  stagedPath: string | null;
  backupPath: string | null;
}

async function readExisting(path: string): Promise<Buffer | null> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new SymlinkPathError(path);
    if (!metadata.isFile()) {
      throw new InvalidTransactionError(`Transaction target is not a file: ${path}`);
    }
    return await readFile(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validateRelativePath(vault: string, path: string): string {
  const absolutePath = resolveInside(vault, path);
  const canonical = relative(vault, absolutePath).split(sep).join("/");
  if (canonical === ".ckb" || canonical.startsWith(".ckb/")) {
    throw new InvalidTransactionError("Live transactions cannot target internal .ckb state");
  }
  return absolutePath;
}

function validateInternalPath(vault: string, path: string): string {
  const normalized = path.split(sep).join("/");
  const permitted = /^\.ckb\/reviews\/(?:archive\/)?[0-9a-f-]{36}\.json$/.test(normalized) ||
    normalized === ".ckb/compiler/current/manifest.json";
  if (!permitted) {
    throw new InvalidTransactionError(`Internal transaction target is not permitted: ${path}`);
  }
  return resolveInside(vault, path);
}

async function stageContent(
  absolutePath: string,
  content: string | Buffer,
  operationId: string,
): Promise<string> {
  const stagedPath = `${absolutePath}.ckb-${operationId.slice(3)}.tmp`;
  const handle = await open(stagedPath, "wx", 0o600);
  try {
    if (Buffer.isBuffer(content)) await handle.writeFile(content);
    else await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return stagedPath;
}

async function ensureParentDirectories(
  vault: string,
  absolutePath: string,
  createdDirectories: string[],
): Promise<void> {
  const root = resolve(vault);
  const parent = dirname(absolutePath);
  const relativeParent = relative(root, parent);
  let cursor = root;
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) throw new SymlinkPathError(cursor);
      if (!metadata.isDirectory()) {
        throw new InvalidTransactionError(`Transaction parent is not a directory: ${cursor}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(cursor, { mode: 0o700 });
        createdDirectories.push(cursor);
      } catch (mkdirError: unknown) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        const metadata = await lstat(cursor);
        if (metadata.isSymbolicLink()) throw new SymlinkPathError(cursor);
        if (!metadata.isDirectory()) {
          throw new InvalidTransactionError(`Transaction parent is not a directory: ${cursor}`);
        }
      }
    }
  }
}

async function removeCreatedDirectories(paths: string[]): Promise<void> {
  for (const path of [...paths].reverse()) {
    await rmdir(path).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    });
  }
}

async function removeIfPresent(path: string | null): Promise<void> {
  if (path === null) return;
  await unlink(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

async function restoreTarget(
  vault: string,
  change: PreparedChange,
  operationId: string,
): Promise<void> {
  if (change.backupPath !== null) {
    const current = await readExisting(change.absolutePath);
    const currentHash = current === null ? null : sha256(current);
    if (currentHash !== null && currentHash !== change.newHash) {
      throw new RecoveryConflictError(change.path);
    }
    await removeIfPresent(change.absolutePath);
    await rename(change.backupPath, change.absolutePath);
    change.backupPath = null;
    return;
  }
  if (change.previousObjectHash === null) {
    await removeIfPresent(change.absolutePath);
    return;
  }
  const previous = await getObjectBuffer(vault, change.previousObjectHash);
  const staged = await stageContent(change.absolutePath, previous, `${operationId}-rollback`);
  await rename(staged, change.absolutePath);
}

async function installStagedExclusively(change: PreparedChange): Promise<void> {
  if (change.stagedPath === null) {
    throw new InvalidTransactionError(`Missing staged content for ${change.path}`);
  }
  try {
    await link(change.stagedPath, change.absolutePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const current = await readExisting(change.absolutePath);
      throw new StaleRevisionError(
        change.path,
        null,
        current === null ? null : sha256(current),
      );
    }
    throw error;
  }
  await removeIfPresent(change.stagedPath);
  change.stagedPath = null;
}

async function verifyAppliedChange(change: PreparedChange): Promise<void> {
  if (change.backupPath !== null && change.previousHash !== null) {
    const displacedHash = sha256(await readFile(change.backupPath));
    if (displacedHash !== change.previousHash) {
      throw new StaleRevisionError(change.path, change.previousHash, displacedHash);
    }
  }
  const current = await readExisting(change.absolutePath);
  const currentHash = current === null ? null : sha256(current);
  if (currentHash !== change.newHash) {
    throw new StaleRevisionError(change.path, change.newHash, currentHash);
  }
}

function journalChanges(changes: PreparedChange[]): JournalEvent["changes"] {
  return changes
    .filter((change) => change.previousHash !== change.newHash)
    .map((change) => ({
      path: change.path,
      previousHash: change.previousHash,
      newHash: change.newHash,
      previousObjectHash: change.previousObjectHash,
    }));
}

export function createTransactionApplier(options: TransactionApplierOptions = {}) {
  return async function apply(input: TransactionInput): Promise<TransactionResult> {
    if (
      input.changes.length === 0 &&
      (input.internalChanges?.length ?? 0) === 0 &&
      input.nextState === undefined
    ) {
      throw new InvalidTransactionError("A transaction must contain a file or state change");
    }
    if (!input.actor.trim()) throw new InvalidTransactionError("Transaction actor is required");
    if (input.nextState !== undefined) WorkspaceStateSchema.parse(input.nextState);
    if (input.nextState !== undefined && !input.expectedStateHash) {
      throw new InvalidTransactionError("State-changing transactions require expectedStateHash");
    }
    if (input.nextState === undefined && input.expectedStateHash !== undefined) {
      throw new InvalidTransactionError("expectedStateHash requires a nextState update");
    }
    if (input.expectedStateHash !== undefined && !hashPattern.test(input.expectedStateHash)) {
      throw new InvalidTransactionError("Invalid expected state hash");
    }

    const operationId = input.operationId ?? newOperationId();
    if (!/^op:[0-9a-f-]{36}$/.test(operationId)) {
      throw new InvalidTransactionError(`Invalid operation ID: ${operationId}`);
    }
    if (input.lock && input.lock.operationId !== operationId) {
      throw new InvalidTransactionError("Supplied workspace lock belongs to another operation");
    }
    const ownsLock = input.lock === undefined;
    const lock = input.lock ?? (await acquireWorkspaceLock(input.vault, operationId));
    const prepared: PreparedChange[] = [];
    const applied: PreparedChange[] = [];
    const createdDirectories: string[] = [];
    let previousState: WorkspaceState | undefined;
    let previousStateSerialized: string | undefined;
    let previousStateObjectHash: string | undefined;
    let stateChanged = false;
    let recoveryWritten = false;
    let committed = false;

    try {
      if ((await readJournal(input.vault)).some((event) => event.operationId === operationId)) {
        throw new InvalidTransactionError(`Operation ID has already been used: ${operationId}`);
      }
      if (input.nextState !== undefined && input.expectedStateHash !== undefined) {
        const stateSnapshot = await loadStateSnapshot(input.vault);
        if (stateSnapshot.hash !== input.expectedStateHash) {
          throw new StaleStateError(input.expectedStateHash, stateSnapshot.hash);
        }
        previousState = stateSnapshot.state;
        previousStateSerialized = await readFile(join(input.vault, ".ckb/state.json"), "utf8");
        if (sha256(previousStateSerialized) !== stateSnapshot.hash) {
          throw new StaleStateError(input.expectedStateHash, sha256(previousStateSerialized));
        }
      }

      const seen = new Set<string>();
      const allChanges = [
        ...input.changes.map((change) => ({ change, internal: false })),
        ...(input.internalChanges ?? []).map((change) => ({ change, internal: true })),
      ];
      for (const { change, internal } of allChanges) {
        if (change.expectedHash !== null && !hashPattern.test(change.expectedHash)) {
          throw new InvalidTransactionError(`Invalid expected hash for ${change.path}`);
        }
        const absolutePath = internal
          ? validateInternalPath(input.vault, change.path)
          : validateRelativePath(input.vault, change.path);
        const canonicalPath = relative(input.vault, absolutePath).split(sep).join("/");
        if (seen.has(canonicalPath)) {
          throw new InvalidTransactionError(`Duplicate transaction target: ${canonicalPath}`);
        }
        seen.add(canonicalPath);
        await assertNoSymlinkAncestors(input.vault, absolutePath);
        const previous = await readExisting(absolutePath);
        const previousHash = previous === null ? null : sha256(previous);
        if (change.expectedHash !== previousHash) {
          throw new StaleRevisionError(canonicalPath, change.expectedHash, previousHash);
        }
        prepared.push({
          ...change,
          path: canonicalPath,
          absolutePath,
          previousContent: previous,
          previousHash,
          previousObjectHash: null,
          newHash: change.content === null ? null : sha256(change.content),
          stagedPath: null,
          backupPath: null,
        });
      }

      for (const object of input.objects ?? []) await putObject(input.vault, object);

      for (const change of prepared) {
        if (change.previousContent !== null) {
          change.previousObjectHash = await putObject(input.vault, change.previousContent);
        }
        if (change.content !== null && change.previousHash !== change.newHash) {
          await ensureParentDirectories(input.vault, change.absolutePath, createdDirectories);
          change.stagedPath = await stageContent(change.absolutePath, change.content, operationId);
        }
      }

      if (previousStateSerialized !== undefined) {
        previousStateObjectHash = await putObject(input.vault, previousStateSerialized);
      }
      const recovery: RecoveryRecord = {
        schemaVersion: 1,
        operationId,
        actor: input.actor,
        createdAt: new Date().toISOString(),
        changes: prepared
          .filter((change) => change.previousHash !== change.newHash)
          .map((change) => ({
            path: change.path,
            previousHash: change.previousHash,
            previousObjectHash: change.previousObjectHash,
            newHash: change.newHash,
          })),
        ...(input.nextState !== undefined && previousStateObjectHash !== undefined
          ? {
              state: {
                previousHash: input.expectedStateHash!,
                previousObjectHash: previousStateObjectHash,
                newHash: sha256(serializeState(input.nextState)),
              },
            }
          : {}),
      };
      await writeRecoveryRecord(input.vault, recovery);
      recoveryWritten = true;
      await appendJournal(input.vault, {
        schemaVersion: 1,
        operationId,
        actor: input.actor,
        timestamp: new Date().toISOString(),
        result: "prepared",
        conflictCount: 0,
        changes: journalChanges(prepared),
      });

      for (let index = 0; index < prepared.length; index += 1) {
        const change = prepared[index];
        if (!change) continue;
        if (change.previousHash === change.newHash) continue;
        options.failureInjector?.("before_replace", index);
        if (change.previousHash === null) {
          if (change.content === null || change.stagedPath === null) {
            throw new InvalidTransactionError(`Invalid create plan for ${change.path}`);
          }
          await installStagedExclusively(change);
          applied.push(change);
        } else {
          change.backupPath = `${change.absolutePath}.ckb-${operationId.slice(3)}.bak`;
          await rename(change.absolutePath, change.backupPath);
          applied.push(change);
          options.failureInjector?.("after_displace", index);
          const displaced = await readFile(change.backupPath);
          const displacedHash = sha256(displaced);
          if (displacedHash !== change.previousHash) {
            throw new StaleRevisionError(change.path, change.previousHash, displacedHash);
          }
          if (change.content !== null) {
            await installStagedExclusively(change);
          }
        }
        options.failureInjector?.("after_rename", index);
      }

      for (const change of applied) {
        await verifyAppliedChange(change);
      }

      if (input.nextState !== undefined) {
        await saveState(input.vault, input.nextState);
        stateChanged = true;
        options.failureInjector?.("after_state_save", prepared.length);
      }

      for (const change of applied) {
        await verifyAppliedChange(change);
      }

      const changes = journalChanges(prepared);
      await appendJournal(input.vault, {
        schemaVersion: 1,
        operationId,
        actor: input.actor,
        timestamp: new Date().toISOString(),
        result: "applied",
        conflictCount: 0,
        changes,
      });
      committed = true;
      try {
        options.failureInjector?.("after_commit", prepared.length);
        for (const change of applied) {
          await removeIfPresent(change.backupPath);
          change.backupPath = null;
        }
        await removeRecoveryRecord(input.vault, operationId);
        recoveryWritten = false;
      } catch {
        // The applied journal entry is the commit point. Recovery will only
        // finish cleanup for an operation that reached this point.
      }
      return { operationId, result: "applied", changes };
    } catch (error: unknown) {
      let errorToThrow = error;
      if (applied.length > 0 || stateChanged) {
        const rollbackErrors: unknown[] = [];
        for (const change of [...applied].reverse()) {
          try {
            await restoreTarget(input.vault, change, operationId);
          } catch (rollbackError: unknown) {
            rollbackErrors.push(rollbackError);
          }
        }
        try {
          if (stateChanged && previousState !== undefined) await saveState(input.vault, previousState);
        } catch (rollbackError: unknown) {
          rollbackErrors.push(rollbackError);
        }
        try {
          await appendJournal(input.vault, {
            schemaVersion: 1,
            operationId,
            actor: input.actor,
            timestamp: new Date().toISOString(),
            result: "rolled_back",
            conflictCount: 0,
            changes: journalChanges(prepared),
          });
        } catch (rollbackError: unknown) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length === 0) {
          if (recoveryWritten) {
            await removeRecoveryRecord(input.vault, operationId);
            recoveryWritten = false;
          }
        } else {
          const rollbackError = rollbackErrors[0];
          errorToThrow = new TransactionRollbackError(
            `Rollback failed after ${error instanceof Error ? error.message : String(error)}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      if (recoveryWritten && !(errorToThrow instanceof TransactionRollbackError)) {
        await removeRecoveryRecord(input.vault, operationId);
        recoveryWritten = false;
      }
      await removeCreatedDirectories(createdDirectories);
      throw errorToThrow;
    } finally {
      try {
        for (const change of prepared) await removeIfPresent(change.stagedPath);
        if (ownsLock) await lock.release();
      } catch (cleanupError: unknown) {
        if (!committed) throw cleanupError;
      }
    }
  };
}

export const applyTransaction = createTransactionApplier();
