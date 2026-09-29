import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/).nullable();

export const JournalEventSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().startsWith("op:"),
  actor: z.string().min(1),
  timestamp: z.string().datetime(),
  result: z.enum(["prepared", "applied", "rolled_back", "recovered"]),
  conflictCount: z.number().int().nonnegative(),
  changes: z.array(
    z.object({
      path: z.string().min(1),
      previousHash: HashSchema,
      newHash: HashSchema,
      previousObjectHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
    }),
  ),
});

export type JournalEvent = z.infer<typeof JournalEventSchema>;

export async function appendJournal(vault: string, event: JournalEvent): Promise<void> {
  const validated = JournalEventSchema.parse(event);
  const path = join(vault, ".ckb/journal.jsonl");
  const handle = await open(path, "a+", 0o600);
  try {
    const current = await readFile(path);
    if (current.length > 0 && current[current.length - 1] !== 0x0a) {
      await handle.truncate(current.lastIndexOf(0x0a) + 1);
      await handle.sync();
    }
    await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJournal(vault: string): Promise<JournalEvent[]> {
  const raw = await readFile(join(vault, ".ckb/journal.jsonl"), "utf8");
  const lines = raw.split("\n");
  if (!raw.endsWith("\n")) lines.pop();
  return lines
    .filter(Boolean)
    .map((line) => JournalEventSchema.parse(JSON.parse(line) as unknown));
}
