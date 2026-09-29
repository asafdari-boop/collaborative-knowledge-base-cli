import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import {
  DependencyUnavailableError,
  IncompleteCensusError,
  MalformedExportError,
} from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { assertNoSymlinkAncestors, resolveInside } from "../core/paths.js";
import {
  ExporterAccountListSchema,
  ExporterFolderListSchema,
  ExporterManifestSchema,
  ExporterNoteListSchema,
  ExporterResultSchema,
  parseExporterJson,
  type ExporterNoteList,
  type ExporterFolderList,
  type ExporterManifest,
} from "./apple-notes-exporter-contract.js";
import { runProcess, type ProcessResult, type ProcessRunner } from "./process-runner.js";
import {
  ExtractionCensusSchema,
  type ExtractedAttachment,
  type ExtractedInternalLink,
  type ExtractedNote,
  type ExtractionOptions,
  type ExtractionResult,
  type NotesExtractor,
} from "./types.js";

const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024;
const MANIFEST_FILENAME = "AppleNotesExportSyncWatermark.json";
const NOTE_CENSUS_ATTEMPTS = 5;
const EXPORT_ATTEMPTS = 5;

export interface AppleNotesExporterOptions {
  executable: string;
  executableArguments?: string[];
  databasePath?: string;
  runner?: ProcessRunner;
}

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function exactScope(notes: ExporterNoteList["notes"], options: ExtractionOptions) {
  const accounts = new Set(options.accountAllowlist);
  const folders = new Set(options.folderAllowlist);
  const requestedIds = new Set(options.noteIdAllowlist ?? []);
  const scoped = notes.filter(
    (note) =>
      (accounts.size === 0 || accounts.has(note.accountName)) &&
      (folders.size === 0 || folders.has(note.folderName)) &&
      (requestedIds.size === 0 || requestedIds.has(note.id)),
  );
  if (requestedIds.size > 0) {
    const selectedIds = new Set(scoped.map((note) => note.id));
    const missing = [...requestedIds].filter((id) => !selectedIds.has(id)).sort();
    if (missing.length > 0) {
      throw new IncompleteCensusError(
        `The configured note ID allowlist is incomplete: ${missing.length} ID${missing.length === 1 ? " is" : "s are"} missing`,
      );
    }
  }
  const maximum = options.maximumNoteCount ?? 20;
  if (scoped.length === 0) {
    throw new IncompleteCensusError("The exact Apple Notes scope selected zero notes");
  }
  if (scoped.length > maximum) {
    throw new IncompleteCensusError(
      `The exact Apple Notes scope selected ${scoped.length} notes, over the configured maximum of ${maximum}`,
    );
  }
  return [...scoped].sort((left, right) => left.id.localeCompare(right.id));
}

function censusSignature(notes: ExporterNoteList["notes"]): string {
  return JSON.stringify(
    notes
      .map((note) => ({
        id: note.id,
        modifiedAt: normalizeTimestamp(note.modificationDate),
        accountId: note.accountId,
        folderId: note.folderId,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function assertUniqueNoteIds(notes: ExporterNoteList["notes"]): void {
  const seen = new Set<string>();
  for (const note of notes) {
    if (seen.has(note.id)) {
      throw new MalformedExportError(`The exporter returned duplicate note ID ${note.id}`);
    }
    seen.add(note.id);
  }
}

function enrichNoteNames(
  notes: ExporterNoteList["notes"],
  accounts: { id: string; name: string }[],
  folders: ExporterFolderList["folders"],
): ExporterNoteList["notes"] {
  const accountNames = new Map(accounts.map((account) => [account.id, account.name]));
  const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
  return notes.map((note) => ({
    ...note,
    accountName: accountNames.get(note.accountId) ?? note.accountName,
    folderName: folderNames.get(note.folderId) ?? note.folderName,
  }));
}

function inferUti(path: string): string {
  const extension = posix.extname(path).toLowerCase();
  const known: Record<string, string> = {
    ".txt": "public.plain-text",
    ".md": "net.daringfireball.markdown",
    ".pdf": "com.adobe.pdf",
    ".png": "public.png",
    ".jpg": "public.jpeg",
    ".jpeg": "public.jpeg",
    ".gif": "com.compuserve.gif",
  };
  return known[extension] ?? "public.data";
}

function resolveExportPath(exportRoot: string, relativePath: string): string {
  try {
    return resolveInside(exportRoot, relativePath);
  } catch (error: unknown) {
    throw new MalformedExportError(
      `Export path is not confined: ${relativePath}${
        error instanceof Error ? ` (${error.message})` : ""
      }`,
    );
  }
}

function decodeHref(href: string): string | null {
  const withoutFragment = href.split(/[?#]/, 1)[0] ?? "";
  if (!withoutFragment || /^[a-z][a-z0-9+.-]*:/i.test(withoutFragment)) return null;
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return null;
  }
}

function extractInternalLinks(
  markdown: string,
  currentPath: string,
  pathToNoteId: ReadonlyMap<string, string>,
): ExtractedInternalLink[] {
  const links: ExtractedInternalLink[] = [];
  const seen = new Set<string>();
  const pattern = /(?<!!)\[([^\]]*)\]\(((?:[^\s()]|\([^)]*\))+)(?:\s+"[^"]*")?\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    const decoded = decodeHref(href);
    if (decoded === null) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(currentPath), decoded));
    const targetNoteId = pathToNoteId.get(resolved);
    if (!targetNoteId) continue;
    const key = `${targetNoteId}\u0000${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ href, ...(label ? { label } : {}), targetNoteId });
  }
  return links;
}

const NATIVE_APPLE_NOTE_REFERENCE =
  /(^|[\n\u2028\u2029])([^\n\u2028\u2029]*?)\s*\[(applenotes:(?:\/\/)?[^\]\n\u2028\u2029]+)\]/gi;

function cleanNativeAppleNoteLabel(value: string): string {
  return value
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^(?:(?:\*\*|__)+)|(?:(?:\*\*|__)+)$/g, "")
    .trim();
}

function nativeIdentifier(href: string): string | null {
  const match = /(?:applenotes:note\/|applenotes:\/\/showNote\?identifier=)([0-9a-f-]{36})/i
    .exec(href);
  return match?.[1]?.toLocaleLowerCase("en-US") ?? null;
}

export function loadNativeNoteIdentifierMap(databasePath: string): Map<string, string> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(
      "SELECT CAST(Z_PK AS TEXT) AS noteId, ZIDENTIFIER AS identifier " +
      "FROM ZICCLOUDSYNCINGOBJECT WHERE ZIDENTIFIER IS NOT NULL",
    ).all() as { noteId: string; identifier: string }[];
    return new Map(rows.map((row) => [
      row.identifier.toLocaleLowerCase("en-US"),
      row.noteId,
    ]));
  } finally {
    database.close();
  }
}

export function extractNativeAppleNoteLinks(
  markdown: string,
  identifierToNoteId: ReadonlyMap<string, string>,
): ExtractedInternalLink[] {
  const links: ExtractedInternalLink[] = [];
  const seen = new Set<string>();
  for (const match of markdown.replace(/\r\n?/g, "\n").matchAll(NATIVE_APPLE_NOTE_REFERENCE)) {
    const href = match[3] ?? "";
    const identifier = nativeIdentifier(href);
    if (identifier === null) continue;
    const targetNoteId = identifierToNoteId.get(identifier);
    if (!targetNoteId) continue;
    const label = cleanNativeAppleNoteLabel(match[2] ?? "");
    const key = `${targetNoteId}\u0000${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ href, ...(label ? { label } : {}), targetNoteId });
  }
  return links;
}

export class AppleNotesExporter implements NotesExtractor {
  private readonly executableArguments: string[];
  private readonly runner: ProcessRunner;

  public constructor(private readonly exporter: AppleNotesExporterOptions) {
    this.executableArguments = [...(exporter.executableArguments ?? [])];
    this.runner = exporter.runner ?? runProcess;
  }

  private async run(args: string[], options: ExtractionOptions): Promise<ProcessResult> {
    const commandArgs = this.exporter.databasePath && args[0] !== "--version"
      ? [args[0] ?? "", "--db", this.exporter.databasePath, ...args.slice(1)]
      : args;
    return this.runner({
      executable: this.exporter.executable,
      args: [...this.executableArguments, ...commandArgs],
      timeoutMs: options.timeoutMs,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  private async runSuccessful(args: string[], options: ExtractionOptions, label: string) {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) {
      throw new IncompleteCensusError(
        `${label} failed with exit ${String(result.exitCode)}: ${result.stderr.trim()}`,
      );
    }
    return result;
  }

  private async readNoteCensus(
    args: string[],
    options: ExtractionOptions,
    label: string,
  ): Promise<ExporterNoteList> {
    let parsed: ExporterNoteList | null = null;
    for (let attempt = 0; attempt < NOTE_CENSUS_ATTEMPTS; attempt += 1) {
      const result = await this.runSuccessful(args, options, label);
      parsed = parseExporterJson(label, result.stdout, ExporterNoteListSchema);
      if (parsed.notes.length > 0) return parsed;
      if (attempt + 1 < NOTE_CENSUS_ATTEMPTS) {
        const delayMs = 500 * 2 ** attempt;
        if (options.signal) await delay(delayMs, undefined, { signal: options.signal });
        else await delay(delayMs);
      }
    }
    return parsed ?? { notes: [], count: 0 };
  }

  private async readNonEmptyList<T>(
    args: string[],
    options: ExtractionOptions,
    label: string,
    decode: (stdout: string) => T,
    size: (value: T) => number,
  ): Promise<T> {
    let parsed: T | undefined;
    for (let attempt = 0; attempt < NOTE_CENSUS_ATTEMPTS; attempt += 1) {
      const result = await this.runSuccessful(args, options, label);
      parsed = decode(result.stdout);
      if (size(parsed) > 0) return parsed;
      if (attempt + 1 < NOTE_CENSUS_ATTEMPTS) {
        const delayMs = 500 * 2 ** attempt;
        if (options.signal) await delay(delayMs, undefined, { signal: options.signal });
        else await delay(delayMs);
      }
    }
    return parsed!;
  }

  public async extract(options: ExtractionOptions): Promise<ExtractionResult> {
    options.signal?.throwIfAborted();
    const startedAt = new Date().toISOString();

    let versionResult: ProcessResult;
    try {
      versionResult = await this.run(["--version"], options);
    } catch (error: unknown) {
      throw new DependencyUnavailableError(
        "Apple Notes Exporter",
        error instanceof Error ? error.message : String(error),
      );
    }
    const version = versionResult.stdout.trim();
    if (versionResult.exitCode !== 0 || !/^2(?:\.|$)/.test(version)) {
      throw new DependencyUnavailableError(
        "Apple Notes Exporter v2",
        versionResult.stderr.trim() || `reported version ${version || "unknown"}`,
      );
    }

    const accounts = await this.readNonEmptyList(
      ["list-accounts", "--format", "json"],
      options,
      "Account census",
      (stdout) => parseExporterJson("Account census", stdout, ExporterAccountListSchema),
      (value) => value.accounts.length,
    );
    const folders = await this.readNonEmptyList(
      ["list-folders", "--format", "json"],
      options,
      "Folder census",
      (stdout) => parseExporterJson("Folder census", stdout, ExporterFolderListSchema),
      (value) => value.folders.length,
    );

    const listArgs = ["list-notes", "--format", "json"];
    const beforeRaw = await this.readNoteCensus(listArgs, options, "Pre-export note census");
    const beforeAll = {
      ...beforeRaw,
      notes: enrichNoteNames(beforeRaw.notes, accounts.accounts, folders.folders),
    };
    assertUniqueNoteIds(beforeAll.notes);
    const before = exactScope(beforeAll.notes, options);

    const requestedExportIds = new Set(before.map((note) => note.id));
    let exportRoot = "";
    let manifest: ExporterManifest | null = null;
    for (let attempt = 1; attempt <= EXPORT_ATTEMPTS; attempt += 1) {
      const attemptRoot = join(
        resolve(options.stagingDirectory),
        `apple-notes-export-attempt-${attempt}`,
      );
      if (options.previousExportRoot) {
        await cp(resolve(options.previousExportRoot), attemptRoot, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      } else {
        await mkdir(attemptRoot, { recursive: true });
      }

      const exportResultRaw = await this.run(
        [
          "export",
          "--output",
          attemptRoot,
          "--format",
          "markdown",
          "--incremental",
          "--notes",
          [...requestedExportIds].join(","),
        ],
        options,
      );
      const exportResult = parseExporterJson(
        "Markdown export",
        exportResultRaw.stdout,
        ExporterResultSchema,
      );
      if (
        exportResultRaw.exitCode !== 0 ||
        !exportResult.success ||
        exportResult.failed > 0 ||
        exportResult.failedAttachments > 0
      ) {
        throw new IncompleteCensusError(
          `Apple Notes export was partial: ${exportResult.failed} notes and ${exportResult.failedAttachments} attachments failed`,
        );
      }
      if (resolve(exportResult.outputDirectory) !== resolve(attemptRoot)) {
        throw new MalformedExportError("Exporter reported an unexpected output directory");
      }

      const manifestRaw = await readFile(join(attemptRoot, MANIFEST_FILENAME), "utf8").catch(
        () => null,
      );
      if (manifestRaw === null) continue;
      const candidate = parseExporterJson(
        MANIFEST_FILENAME,
        manifestRaw,
        ExporterManifestSchema,
      );
      const manifestIds = new Set(Object.keys(candidate.notes));
      const hasExtra = [...manifestIds].some((id) => !requestedExportIds.has(id));
      if (hasExtra) {
        throw new MalformedExportError(
          "The exporter manifest contains a note outside the exact selected scope",
        );
      }
      const complete =
        exportResult.exported + exportResult.skipped === requestedExportIds.size &&
        [...requestedExportIds].every((id) => manifestIds.has(id));
      if (!complete) continue;
      exportRoot = attemptRoot;
      manifest = candidate;
      break;
    }
    if (manifest === null) {
      throw new IncompleteCensusError(
        `Apple Notes Exporter did not produce a complete ${requestedExportIds.size}-note manifest after ${EXPORT_ATTEMPTS} attempts`,
      );
    }

    const afterRaw = await this.readNoteCensus(listArgs, options, "Post-export note census");
    const afterAll = {
      ...afterRaw,
      notes: enrichNoteNames(afterRaw.notes, accounts.accounts, folders.folders),
    };
    assertUniqueNoteIds(afterAll.notes);
    const after = exactScope(afterAll.notes, options);
    if (censusSignature(before) !== censusSignature(after)) {
      throw new IncompleteCensusError("The Apple Notes census changed while export was running");
    }

    const selectedIds = new Set(after.map((note) => note.id));
    const pathToNoteId = new Map<string, string>();
    for (const [noteId, entry] of Object.entries(manifest.notes)) {
      if (!selectedIds.has(noteId)) {
        throw new MalformedExportError(
          "The exporter manifest contains a note outside the exact selected scope",
        );
      }
      const normalized = posix.normalize(entry.exportedPath);
      if (normalized !== entry.exportedPath || !normalized.endsWith(".md")) {
        throw new MalformedExportError(`Unsafe or non-Markdown export path: ${entry.exportedPath}`);
      }
      resolveExportPath(exportRoot, normalized);
      if (pathToNoteId.has(normalized)) {
        throw new MalformedExportError(`Multiple note IDs resolve to ${normalized}`);
      }
      pathToNoteId.set(normalized, noteId);
    }
    let identifierToNoteId = new Map<string, string>();
    if (this.exporter.databasePath) {
      const databaseMetadata = await stat(this.exporter.databasePath).catch(() => null);
      if (databaseMetadata?.isFile()) {
        identifierToNoteId = loadNativeNoteIdentifierMap(this.exporter.databasePath);
      }
    }

    const notes: ExtractedNote[] = [];
    for (const note of [...after].sort((left, right) => left.id.localeCompare(right.id))) {
      const entry = manifest.notes[note.id];
      if (!entry) {
        throw new IncompleteCensusError(`No successful Markdown export exists for note ${note.id}`);
      }
      const markdownPath = resolveExportPath(exportRoot, entry.exportedPath);
      await assertNoSymlinkAncestors(exportRoot, markdownPath);
      const metadata = await stat(markdownPath).catch(() => null);
      if (!metadata?.isFile()) {
        throw new MalformedExportError(`Exported note is missing: ${entry.exportedPath}`);
      }
      const markdown = await readFile(markdownPath, "utf8");
      const attachments: ExtractedAttachment[] = [];
      for (const relativePath of entry.attachmentPaths) {
        const attachmentPath = resolveExportPath(exportRoot, relativePath);
        await assertNoSymlinkAncestors(exportRoot, attachmentPath);
        const attachmentMetadata = await stat(attachmentPath).catch(() => null);
        if (!attachmentMetadata?.isFile()) {
          throw new MalformedExportError(`Exported attachment is missing: ${relativePath}`);
        }
        attachments.push({
          id: `export-path:${sha256(relativePath)}`,
          uti: inferUti(relativePath),
          filename: basename(relativePath),
          relativePath,
          sizeBytes: attachmentMetadata.size,
        });
      }
      // Apple Notes includes non-file objects (for example tables, URLs,
      // hashtags, and mentions) in attachmentCount. The exporter renders those
      // into Markdown but intentionally omits them from attachmentPaths. Its
      // failedAttachments result remains the completeness check for file-backed
      // media; the manifest must never contain more files than Notes declared.
      if (attachments.length > note.attachmentCount) {
        throw new IncompleteCensusError(
          `Attachment census mismatch for note ${note.id}: Notes declared ${note.attachmentCount}, but the manifest exported ${attachments.length} files`,
        );
      }
      notes.push({
        id: note.id,
        title: note.title,
        accountId: note.accountId,
        accountName: note.accountName,
        folderId: note.folderId,
        folderName: note.folderName,
        createdAt: normalizeTimestamp(note.creationDate),
        modifiedAt: normalizeTimestamp(note.modificationDate),
        markdown,
        exportedRelativePath: entry.exportedPath,
        accessibility: "readable",
        sensitivity: "permitted",
        attachments,
        internalLinks: [
          ...extractInternalLinks(markdown, entry.exportedPath, pathToNoteId),
          ...extractNativeAppleNoteLinks(markdown, identifierToNoteId),
        ],
      });
    }

    const availableAccountNames = [...new Set(accounts.accounts.map((account) => account.name))].sort();
    const unsupportedAccounts = options.accountAllowlist.filter(
      (account) => !availableAccountNames.includes(account),
    );
    const warnings = unsupportedAccounts.map((account) => ({
      code: "unsupported_account",
      message: `Configured account was not visible to Apple Notes Exporter: ${account}`,
    }));
    const census = ExtractionCensusSchema.parse({
      schemaVersion: 1,
      extractor: { name: "apple-notes-exporter", version },
      startedAt,
      completedAt: new Date().toISOString(),
      complete: true,
      coverage: {
        requestedAccountAllowlist: options.accountAllowlist,
        requestedFolderAllowlist: options.folderAllowlist,
        requestedNoteIdAllowlist: options.noteIdAllowlist ?? [],
        maximumNoteCount: options.maximumNoteCount ?? 20,
        supportedAccounts: availableAccountNames,
        unsupportedAccounts,
        noteCount: notes.length,
      },
      warnings,
      notes,
    });
    return { census, exportRoot };
  }
}
