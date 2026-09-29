import { z } from "zod";
import { MalformedExportError } from "../core/errors.js";

const DateStringSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "Expected an ISO-compatible date",
});

export const ExporterAccountListSchema = z
  .object({
    accounts: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        type: z.string(),
      }),
    ),
    count: z.number().int().nonnegative(),
  })
  .refine((value) => value.count === value.accounts.length, "Account count is inconsistent");

export const ExporterNoteListSchema = z
  .object({
    notes: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        folderId: z.string().min(1),
        folderName: z.string(),
        accountId: z.string().min(1),
        accountName: z.string(),
        creationDate: DateStringSchema,
        modificationDate: DateStringSchema,
        attachmentCount: z.number().int().nonnegative(),
        plaintext: z.string().nullable().optional(),
      }),
    ),
    count: z.number().int().nonnegative(),
  })
  .refine((value) => value.count === value.notes.length, "Note count is inconsistent");

export const ExporterFolderListSchema = z
  .object({
    folders: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        parentId: z.string().nullable().optional(),
        accountId: z.string().min(1),
        accountName: z.string(),
      }),
    ),
    count: z.number().int().nonnegative(),
  })
  .refine((value) => value.count === value.folders.length, "Folder count is inconsistent");

export const ExporterResultSchema = z.object({
  success: z.boolean(),
  exported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failedAttachments: z.number().int().nonnegative(),
  outputDirectory: z.string().min(1),
  format: z.string().min(1),
  durationSeconds: z.number().nonnegative(),
});

export const ExporterManifestSchema = z.object({
  version: z.literal(1),
  lastSync: z.number(),
  notes: z.record(
    z.string(),
    z.object({
      modificationDate: z.number(),
      exportedPath: z.string().min(1),
      attachmentPaths: z.array(z.string().min(1)),
    }),
  ),
});

export type ExporterNoteList = z.infer<typeof ExporterNoteListSchema>;
export type ExporterFolderList = z.infer<typeof ExporterFolderListSchema>;
export type ExporterManifest = z.infer<typeof ExporterManifestSchema>;

export function parseExporterJson<T>(
  label: string,
  stdout: string,
  schema: z.ZodType<T>,
): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout) as unknown;
  } catch (error: unknown) {
    throw new MalformedExportError(
      `${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new MalformedExportError(`${label} output is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}
