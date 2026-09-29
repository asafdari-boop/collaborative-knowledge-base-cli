import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  InvalidObjectHashError,
  ObjectHashMismatchError,
} from "../core/errors.js";
import { sha256 } from "../core/hash.js";

const objectHashPattern = /^[0-9a-f]{64}$/;

function objectPath(vault: string, hash: string): string {
  if (!objectHashPattern.test(hash)) throw new InvalidObjectHashError(hash);
  return join(vault, ".ckb/objects", hash);
}

async function readVerified(path: string, hash: string): Promise<Buffer> {
  const content = await readFile(path);
  if (sha256(content) !== hash) throw new ObjectHashMismatchError(hash);
  return content;
}

export async function putObject(vault: string, value: string | Buffer): Promise<string> {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const hash = sha256(content);
  const target = objectPath(vault, hash);

  try {
    await readVerified(target, hash);
    return hash;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = join(vault, ".ckb/objects", `.${hash}.tmp-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  await readVerified(target, hash);
  return hash;
}

export async function getObject(vault: string, hash: string): Promise<string> {
  return (await getObjectBuffer(vault, hash)).toString("utf8");
}

export async function getObjectBuffer(vault: string, hash: string): Promise<Buffer> {
  return readVerified(objectPath(vault, hash), hash);
}
