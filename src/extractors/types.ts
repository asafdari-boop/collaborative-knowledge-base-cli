import { z } from "zod";

const TimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "Expected an ISO-compatible timestamp",
});

export const ExtractedAttachmentSchema = z.object({
  id: z.string().min(1),
  uti: z.string().min(1),
  filename: z.string().min(1).nullable().optional(),
  relativePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

export const ExtractedInternalLinkSchema = z.object({
  href: z.string().min(1),
  label: z.string().optional(),
  targetNoteId: z.string().min(1).optional(),
});

export const ExtractedNoteSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    accountId: z.string().min(1),
    accountName: z.string(),
    folderId: z.string().min(1),
    folderName: z.string(),
    createdAt: TimestampSchema,
    modifiedAt: TimestampSchema,
    markdown: z.string().nullable(),
    exportedRelativePath: z.string().min(1).nullable(),
    accessibility: z.enum(["readable", "inaccessible", "locked"]),
    sensitivity: z.enum(["permitted", "excluded"]).default("permitted"),
    attachments: z.array(ExtractedAttachmentSchema),
    internalLinks: z.array(ExtractedInternalLinkSchema),
  })
  .superRefine((note, context) => {
    if (note.accessibility === "readable" && note.markdown === null) {
      context.addIssue({
        code: "custom",
        path: ["markdown"],
        message: "Readable notes require Markdown content",
      });
    }
    if (note.accessibility === "readable" && note.exportedRelativePath === null) {
      context.addIssue({
        code: "custom",
        path: ["exportedRelativePath"],
        message: "Readable notes require an exported path",
      });
    }
  });

export const ExtractionWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  noteId: z.string().min(1).optional(),
});

export const ExtractionCensusSchema = z.object({
  schemaVersion: z.literal(1),
  extractor: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  complete: z.boolean(),
  coverage: z.object({
    requestedAccountAllowlist: z.array(z.string()),
    requestedFolderAllowlist: z.array(z.string()),
    requestedNoteIdAllowlist: z.array(z.string()).default([]),
    maximumNoteCount: z.number().int().positive().default(20),
    supportedAccounts: z.array(z.string()),
    unsupportedAccounts: z.array(z.string()),
    noteCount: z.number().int().nonnegative(),
  }),
  warnings: z.array(ExtractionWarningSchema),
  notes: z.array(ExtractedNoteSchema),
});

export type ExtractedAttachment = z.infer<typeof ExtractedAttachmentSchema>;
export type ExtractedInternalLink = z.infer<typeof ExtractedInternalLinkSchema>;
export type ExtractedNote = z.infer<typeof ExtractedNoteSchema>;
export type ExtractionWarning = z.infer<typeof ExtractionWarningSchema>;
export type ExtractionCensus = z.infer<typeof ExtractionCensusSchema>;

export interface ExtractionOptions {
  stagingDirectory: string;
  previousExportRoot?: string;
  accountAllowlist: string[];
  folderAllowlist: string[];
  noteIdAllowlist?: string[];
  maximumNoteCount?: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExtractionResult {
  census: ExtractionCensus;
  exportRoot: string;
}

export interface NotesExtractor {
  extract(options: ExtractionOptions): Promise<ExtractionResult>;
}
