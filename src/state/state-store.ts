import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { InvalidStateError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import {
  WorkspaceStateSchema,
  type WorkspaceState,
} from "./types.js";

export interface StateSnapshot {
  state: WorkspaceState;
  hash: string;
}

export async function loadStateSnapshot(vault: string): Promise<StateSnapshot> {
  const path = join(vault, ".ckb/state.json");
  let serialized: string;
  let raw: unknown;
  try {
    serialized = await readFile(path, "utf8");
    raw = JSON.parse(serialized) as unknown;
  } catch (error: unknown) {
    throw new InvalidStateError(
      `Unable to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = WorkspaceStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidStateError(`State schema validation failed: ${parsed.error.message}`);
  }
  return { state: parsed.data, hash: sha256(serialized) };
}

export async function loadState(vault: string): Promise<WorkspaceState> {
  return (await loadStateSnapshot(vault)).state;
}

export async function saveState(vault: string, state: WorkspaceState): Promise<void> {
  const parsed = WorkspaceStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new InvalidStateError(`State schema validation failed: ${parsed.error.message}`);
  }

  const statePath = join(vault, ".ckb/state.json");
  const temporary = join(vault, ".ckb", `state.json.tmp-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serializeState(parsed.data), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, statePath);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

export function serializeState(state: WorkspaceState): string {
  const parsed = WorkspaceStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new InvalidStateError(`State schema validation failed: ${parsed.error.message}`);
  }
  return `${JSON.stringify(parsed.data, null, 2)}\n`;
}
