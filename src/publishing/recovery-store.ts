import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InvalidTransactionError } from "../core/errors.js";

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const RecoveryRecordSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().regex(/^op:[0-9a-f-]{36}$/),
  actor: z.string().min(1),
  createdAt: z.string().datetime(),
  changes: z.array(
    z.object({
      path: z.string().min(1),
      previousHash: HashSchema.nullable(),
      previousObjectHash: HashSchema.nullable(),
      newHash: HashSchema.nullable(),
    }),
  ),
  state: z
    .object({
      previousHash: HashSchema,
      previousObjectHash: HashSchema,
      newHash: HashSchema,
    })
    .optional(),
});

export type RecoveryRecord = z.infer<typeof RecoveryRecordSchema>;

function slug(operationId: string): string {
  return operationId.slice("op:".length);
}

export function recoveryRecordPath(vault: string, operationId: string): string {
  return join(vault, ".ckb/recovery", `${slug(operationId)}.json`);
}

export async function writeRecoveryRecord(vault: string, record: RecoveryRecord): Promise<void> {
  const parsed = RecoveryRecordSchema.parse(record);
  await mkdir(join(vault, ".ckb/recovery"), { recursive: true, mode: 0o700 });
  const target = recoveryRecordPath(vault, parsed.operationId);
  const temporary = `${target}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, target);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new InvalidTransactionError(
          `Recovery record already exists for ${parsed.operationId}`,
        );
      }
      throw error;
    }
    const directory = await open(join(vault, ".ckb/recovery"), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

export async function removeRecoveryRecord(vault: string, operationId: string): Promise<void> {
  await unlink(recoveryRecordPath(vault, operationId)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

export async function listRecoveryRecords(vault: string): Promise<RecoveryRecord[]> {
  const names = await readdir(join(vault, ".ckb/recovery")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const records = await Promise.all(
    names
      .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
      .map(async (name) =>
        RecoveryRecordSchema.parse(
          JSON.parse(await readFile(join(vault, ".ckb/recovery", name), "utf8")) as unknown,
        ),
      ),
  );
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
