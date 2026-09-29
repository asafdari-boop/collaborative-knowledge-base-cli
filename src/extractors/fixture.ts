import { cp, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { IncompleteCensusError, MalformedExportError } from "../core/errors.js";
import { resolveInside } from "../core/paths.js";
import {
  ExtractedAttachmentSchema,
  ExtractedInternalLinkSchema,
  ExtractionCensusSchema,
  type ExtractedNote,
  type ExtractionOptions,
  type ExtractionResult,
  type NotesExtractor,
} from "./types.js";

const FixtureNoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  folderId: z.string(),
  folderName: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  markdownPath: z.string().nullable(),
  accessibility: z.enum(["readable", "inaccessible", "locked"]),
  sensitivity: z.enum(["permitted", "excluded"]),
  attachments: z.array(ExtractedAttachmentSchema),
  internalLinks: z.array(ExtractedInternalLinkSchema),
});

const FixtureFileSchema = z.object({
  schemaVersion: z.literal(1),
  extractor: z.object({ name: z.string(), version: z.string() }),
  startedAt: z.string(),
  completedAt: z.string(),
  complete: z.boolean(),
  coverage: z.object({
    supportedAccounts: z.array(z.string()),
    unsupportedAccounts: z.array(z.string()),
  }),
  warnings: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      noteId: z.string().optional(),
    }),
  ),
  notes: z.array(FixtureNoteSchema),
});

export interface FixtureNotesExtractorOptions {
  complete?: boolean;
  failWith?: Error;
}

export class FixtureNotesExtractor implements NotesExtractor {
  private readonly fixtureRoot: string;

  public constructor(
    fixtureRoot: string,
    private readonly fixtureOptions: FixtureNotesExtractorOptions = {},
  ) {
    this.fixtureRoot = resolve(fixtureRoot);
  }

  public async extract(options: ExtractionOptions): Promise<ExtractionResult> {
    options.signal?.throwIfAborted();
    if (this.fixtureOptions.failWith) throw this.fixtureOptions.failWith;

    const raw = FixtureFileSchema.safeParse(
      JSON.parse(await readFile(join(this.fixtureRoot, "census.json"), "utf8")) as unknown,
    );
    if (!raw.success) {
      throw new MalformedExportError(`Synthetic census is invalid: ${raw.error.message}`);
    }

    const exportRoot = join(resolve(options.stagingDirectory), "export");
    await cp(join(this.fixtureRoot, "export"), exportRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    const accountScope = new Set(options.accountAllowlist);
    const folderScope = new Set(options.folderAllowlist);
    const noteIdScope = new Set(options.noteIdAllowlist ?? []);
    const selected = raw.data.notes.filter(
      (note) =>
        (accountScope.size === 0 || accountScope.has(note.accountName)) &&
        (folderScope.size === 0 || folderScope.has(note.folderName)) &&
        (noteIdScope.size === 0 || noteIdScope.has(note.id)),
    );
    if (noteIdScope.size > 0) {
      const selectedIds = new Set(selected.map((note) => note.id));
      const missing = [...noteIdScope].filter((id) => !selectedIds.has(id));
      if (missing.length > 0) {
        throw new MalformedExportError(
          `Synthetic scope is missing ${missing.length} configured note ID${missing.length === 1 ? "" : "s"}`,
        );
      }
    }
    const maximumNoteCount = options.maximumNoteCount ?? 20;
    if (selected.length === 0 || selected.length > maximumNoteCount) {
      throw new IncompleteCensusError(
        `Synthetic scope selected ${selected.length} notes with a maximum of ${maximumNoteCount}`,
      );
    }
    const notes: ExtractedNote[] = [];

    for (const note of selected) {
      options.signal?.throwIfAborted();
      const markdown =
        note.markdownPath === null
          ? null
          : await readFile(resolveInside(exportRoot, note.markdownPath), "utf8");

      for (const attachment of note.attachments) {
        const metadata = await stat(resolveInside(exportRoot, attachment.relativePath));
        if (!metadata.isFile() || metadata.size !== attachment.sizeBytes) {
          throw new MalformedExportError(
            `Synthetic attachment metadata does not match ${attachment.relativePath}`,
          );
        }
      }

      notes.push({
        id: note.id,
        title: note.title,
        accountId: note.accountId,
        accountName: note.accountName,
        folderId: note.folderId,
        folderName: note.folderName,
        createdAt: note.createdAt,
        modifiedAt: note.modifiedAt,
        markdown,
        exportedRelativePath: note.markdownPath,
        accessibility: note.accessibility,
        sensitivity: note.sensitivity,
        attachments: note.attachments,
        internalLinks: note.internalLinks,
      });
    }

    const requestedUnsupported = options.accountAllowlist.filter(
      (account) => !raw.data.coverage.supportedAccounts.includes(account),
    );
    const census = ExtractionCensusSchema.parse({
      schemaVersion: 1,
      extractor: raw.data.extractor,
      startedAt: raw.data.startedAt,
      completedAt: raw.data.completedAt,
      complete: this.fixtureOptions.complete ?? raw.data.complete,
      coverage: {
        requestedAccountAllowlist: options.accountAllowlist,
        requestedFolderAllowlist: options.folderAllowlist,
        requestedNoteIdAllowlist: options.noteIdAllowlist ?? [],
        maximumNoteCount,
        supportedAccounts: raw.data.coverage.supportedAccounts,
        unsupportedAccounts: [
          ...new Set([...raw.data.coverage.unsupportedAccounts, ...requestedUnsupported]),
        ],
        noteCount: notes.length,
      },
      warnings: raw.data.warnings,
      notes,
    });

    options.signal?.throwIfAborted();
    return { census, exportRoot };
  }
}
