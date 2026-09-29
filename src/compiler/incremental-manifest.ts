import { z } from "zod";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { sha256 } from "../core/hash.js";
import { CompilerValidationError } from "../core/errors.js";

export const COMPILER_PROMPT_VERSION = "2";
export const COMPILER_TAXONOMY_VERSION = "1";

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const HashMapSchema = z.record(z.string(), HashSchema);

export const SuccessfulCompilerManifestSchema = z.object({
  schemaVersion: z.literal(1),
  promptVersion: z.string().min(1),
  taxonomyVersion: z.string().min(1),
  compiler: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
  sourceHashes: HashMapSchema,
  wikiHashes: HashMapSchema,
});

export type SuccessfulCompilerManifest = z.infer<typeof SuccessfulCompilerManifestSchema>;

export interface CalculateIncrementalManifestInput {
  sourceHashes: Record<string, string>;
  wikiHashes: Record<string, string>;
  pageSources: Record<string, string[]>;
  pageLinks: Record<string, string[]>;
  previous: SuccessfulCompilerManifest | null;
  rebuild: boolean;
  promptVersion?: string;
  taxonomyVersion?: string;
}

export interface IncrementalCompilerManifest {
  schemaVersion: 1;
  promptVersion: string;
  taxonomyVersion: string;
  currentSourceHashes: Record<string, string>;
  previousSourceHashes: Record<string, string>;
  currentWikiHashes: Record<string, string>;
  previousWikiHashes: Record<string, string>;
  newSources: string[];
  changedSources: string[];
  unchangedSources: string[];
  missingSources: string[];
  humanEditedPages: string[];
  affectedPages: string[];
  affectedMocs: string[];
  rebuild: boolean;
  rebuildReason: "explicit" | "missing_state" | "incompatible_state" | null;
  noOp: boolean;
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isMoc(path: string): boolean {
  return /(?:^|\/)mocs?\//i.test(path) || /(?:^|\/)(?:home|index)\.md$/i.test(path);
}

export function calculateIncrementalManifest(
  input: CalculateIncrementalManifestInput,
): IncrementalCompilerManifest {
  const promptVersion = input.promptVersion ?? COMPILER_PROMPT_VERSION;
  const taxonomyVersion = input.taxonomyVersion ?? COMPILER_TAXONOMY_VERSION;
  const previousSources = input.previous?.sourceHashes ?? {};
  const previousWiki = input.previous?.wikiHashes ?? {};
  const newSources: string[] = [];
  const changedSources: string[] = [];
  const unchangedSources: string[] = [];
  for (const source of sortedKeys(input.sourceHashes)) {
    const previousHash = previousSources[source];
    if (previousHash === undefined) newSources.push(source);
    else if (previousHash === input.sourceHashes[source]) unchangedSources.push(source);
    else changedSources.push(source);
  }
  const missingSources = sortedKeys(previousSources).filter(
    (source) => input.sourceHashes[source] === undefined,
  );
  const humanEditedPages = input.previous === null
    ? []
    : uniqueSorted([
        ...sortedKeys(input.wikiHashes).filter(
          (path) => previousWiki[path] === undefined || previousWiki[path] !== input.wikiHashes[path],
        ),
        ...sortedKeys(previousWiki).filter((path) => input.wikiHashes[path] === undefined),
      ]);
  const changedSet = new Set([...newSources, ...changedSources, ...missingSources]);
  const affected = new Set(humanEditedPages);
  for (const [page, sources] of Object.entries(input.pageSources)) {
    if (sources.some((source) => changedSet.has(source))) affected.add(page);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [page, links] of Object.entries(input.pageLinks)) {
      if (affected.has(page) || links.some((linked) => affected.has(linked))) {
        if (!affected.has(page)) {
          affected.add(page);
          expanded = true;
        }
        for (const linked of links) {
          if (!affected.has(linked)) {
            affected.add(linked);
            expanded = true;
          }
        }
      }
    }
  }
  const incompatible = input.previous !== null && (
    input.previous.promptVersion !== promptVersion ||
    input.previous.taxonomyVersion !== taxonomyVersion
  );
  const rebuildReason = input.rebuild
    ? "explicit" as const
    : input.previous === null
      ? "missing_state" as const
      : incompatible
        ? "incompatible_state" as const
        : null;
  const rebuild = rebuildReason !== null;
  const affectedPages = rebuild ? sortedKeys(input.wikiHashes) : uniqueSorted(affected);
  return {
    schemaVersion: 1,
    promptVersion,
    taxonomyVersion,
    currentSourceHashes: { ...input.sourceHashes },
    previousSourceHashes: { ...previousSources },
    currentWikiHashes: { ...input.wikiHashes },
    previousWikiHashes: { ...previousWiki },
    newSources,
    changedSources,
    unchangedSources,
    missingSources,
    humanEditedPages,
    affectedPages,
    affectedMocs: affectedPages.filter(isMoc),
    rebuild,
    rebuildReason,
    noOp: !rebuild && changedSet.size === 0 && humanEditedPages.length === 0,
  };
}

async function markdownHashes(root: string, directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CompilerValidationError(`Refusing Wiki symlink while hashing ${path}`);
    }
    if (entry.isDirectory()) Object.assign(result, await markdownHashes(root, path));
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const rel = relative(root, path).split(sep).join("/");
      result[`Wiki/${rel}`] = sha256(await readFile(path));
    }
  }
  return result;
}

export async function hashWikiDirectory(wikiDirectory: string): Promise<Record<string, string>> {
  return markdownHashes(wikiDirectory, wikiDirectory);
}

export async function writeSuccessfulCompilerManifest(input: {
  compilerRoot: string;
  compiler: SuccessfulCompilerManifest["compiler"];
  sourceHashes: Record<string, string>;
  wikiHashes: Record<string, string>;
  promptVersion?: string;
  taxonomyVersion?: string;
}): Promise<void> {
  const manifest = SuccessfulCompilerManifestSchema.parse({
    schemaVersion: 1,
    promptVersion: input.promptVersion ?? COMPILER_PROMPT_VERSION,
    taxonomyVersion: input.taxonomyVersion ?? COMPILER_TAXONOMY_VERSION,
    compiler: input.compiler,
    sourceHashes: input.sourceHashes,
    wikiHashes: input.wikiHashes,
  });
  await writeFile(
    join(input.compilerRoot, ".ckb-compiler/manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
