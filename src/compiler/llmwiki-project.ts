import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { CompilerValidationError, SourceMirrorModifiedError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { assertNoSymlinkAncestors, resolveInside } from "../core/paths.js";
import { parsePage } from "../pages/frontmatter.js";
import type { PlannedSourceDocument } from "../normalization/source-plan.js";
import { loadState } from "../state/state-store.js";
import type { LlmwikiProject } from "./types.js";
import { sourceIdentity } from "../normalization/source-id.js";
import { DEFAULT_TAXONOMY } from "../graph/taxonomy.js";
import { extractWikilinkTargets } from "../graph/validate.js";
import {
  calculateIncrementalManifest,
  SuccessfulCompilerManifestSchema,
} from "./incremental-manifest.js";

export interface CreateLlmwikiStagingProjectInput {
  vault: string;
  stagingDirectory: string;
  previousCompilerRoot?: string;
  sourceDocuments?: PlannedSourceDocument[];
  rebuild?: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function copyTreeConfined(source: string, destination: string): Promise<void> {
  await assertNoSymlinkAncestors(source, source);
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CompilerValidationError(`Refusing compiler-state symlink ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await copyTreeConfined(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await writeFile(destinationPath, await readFile(sourcePath), { flag: "wx" });
    } else {
      throw new CompilerValidationError(`Unsupported compiler-state entry ${sourcePath}`);
    }
  }
}

function validateSource(content: string, path: string): void {
  const parsed = parsePage(content);
  for (const field of ["title", "source", "ingestedAt"] as const) {
    if (typeof parsed.attributes[field] !== "string") {
      throw new CompilerValidationError(`Source ${path} is missing ${field}`);
    }
  }
  if (parsed.attributes.sourceType !== "file") {
    throw new CompilerValidationError(`Source ${path} must declare sourceType: file`);
  }
}

function sourceCatalogIdentity(content: string, path: string): { sourceId: string; title: string } {
  const parsed = parsePage(content);
  const rawId = typeof parsed.attributes.appleNoteId === "string"
    ? parsed.attributes.appleNoteId
    : typeof parsed.attributes.source === "string" && parsed.attributes.source.startsWith("applenotes://")
      ? decodeURIComponent(parsed.attributes.source.slice("applenotes://".length))
      : null;
  if (!rawId) throw new CompilerValidationError(`Source ${path} has no stable Apple Note identity`);
  const title = parsed.attributes.title;
  if (typeof title !== "string" || !title.trim()) {
    throw new CompilerValidationError(`Source ${path} has no readable title`);
  }
  return { sourceId: sourceIdentity(rawId).sourceId, title };
}

async function copyLiveWiki(
  vault: string,
  sourceDirectory: string,
  destinationDirectory: string,
  hashes: Record<string, string>,
): Promise<void> {
  const entries = await readdir(sourceDirectory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  await mkdir(destinationDirectory, { recursive: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = join(sourceDirectory, entry.name);
    const destinationPath = join(destinationDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CompilerValidationError(`Refusing live wiki symlink ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await copyLiveWiki(vault, sourcePath, destinationPath, hashes);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      await assertNoSymlinkAncestors(vault, sourcePath);
      const content = await readFile(sourcePath);
      await writeFile(destinationPath, content, { flag: "wx" });
      const relativePath = relative(join(vault, "Wiki"), sourcePath).split(sep).join("/");
      hashes[`Wiki/${relativePath}`] = sha256(content);
    }
  }
}

async function loadPreviousManifest(previousCompilerRoot?: string) {
  if (!previousCompilerRoot) return null;
  try {
    return SuccessfulCompilerManifestSchema.parse(JSON.parse(
      await readFile(join(resolve(previousCompilerRoot), "manifest.json"), "utf8"),
    ));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function wikiRelationships(root: string): Promise<{
  pageSources: Record<string, string[]>;
  pageLinks: Record<string, string[]>;
}> {
  const pageSources: Record<string, string[]> = {};
  const rawLinks: Record<string, string[]> = {};
  const titleToPath = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new CompilerValidationError(`Refusing Wiki symlink ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const relativePath = `Wiki/${relative(join(root, "wiki"), path).split(sep).join("/")}`;
        const content = await readFile(path, "utf8");
        const parsed = parsePage(content);
        const sources = parsed.attributes.sources;
        pageSources[relativePath] = Array.isArray(sources)
          ? sources.filter((source): source is string => typeof source === "string")
          : [];
        rawLinks[relativePath] = extractWikilinkTargets(content);
        titleToPath.set(relativePath.slice("Wiki/".length, -3), relativePath);
        titleToPath.set(entry.name.slice(0, -3), relativePath);
        if (typeof parsed.attributes.title === "string") {
          titleToPath.set(parsed.attributes.title, relativePath);
        }
      }
    }
  }
  await visit(join(root, "wiki"));
  const pageLinks: Record<string, string[]> = {};
  for (const [page, links] of Object.entries(rawLinks)) {
    pageLinks[page] = [...new Set(links.map((link) =>
      titleToPath.get(link.replace(/^Wiki\//, "").replace(/\.md$/, "")) ??
      titleToPath.get(link),
    ).filter((link): link is string => Boolean(link)))].sort();
  }
  return { pageSources, pageLinks };
}

export async function createLlmwikiStagingProject(
  input: CreateLlmwikiStagingProjectInput,
): Promise<LlmwikiProject> {
  const vault = resolve(input.vault);
  const stagingDirectory = resolve(input.stagingDirectory);
  if (stagingDirectory === vault) {
    throw new CompilerValidationError("Compiler staging directory cannot be the live vault");
  }
  await mkdir(stagingDirectory, { recursive: true });
  const root = resolveInside(stagingDirectory, "llmwiki-project");
  await mkdir(root);

  if (input.previousCompilerRoot) {
    const previousState = join(resolve(input.previousCompilerRoot), ".llmwiki");
    if (await pathExists(previousState)) {
      await copyTreeConfined(previousState, join(root, ".llmwiki"));
    }
  }

  const sourcesDirectory = join(root, "sources");
  await mkdir(sourcesDirectory, { recursive: true });
  const sourceFiles: string[] = [];
  const sourceHashes: Record<string, string> = {};
  const sourceCatalog: LlmwikiProject["sourceCatalog"] = {};
  const planned = input.sourceDocuments?.filter((source) => source.compilerEligible);
  const live = planned === undefined
    ? Object.values((await loadState(vault)).sources)
        .filter((source) => source.censusStatus === "present")
        .map((source) => ({
          path: source.path,
          generatedHash: source.generatedHash,
          content: undefined as string | undefined,
        }))
    : planned;
  for (const source of [...live].sort((left, right) => left.path.localeCompare(right.path))) {
    if (!source.generatedHash) {
      throw new CompilerValidationError(`Source state has no generated hash: ${source.path}`);
    }
    let content: Buffer;
    if (source.content === undefined) {
      const absolutePath = resolveInside(vault, source.path);
      await assertNoSymlinkAncestors(vault, absolutePath);
      content = await readFile(absolutePath);
    } else {
      content = Buffer.from(source.content, "utf8");
    }
    if (sha256(content) !== source.generatedHash) {
      throw new SourceMirrorModifiedError(source.path);
    }
    const filename = basename(source.path);
    if (sourceFiles.includes(filename)) {
      throw new CompilerValidationError(`Duplicate compiler source filename ${filename}`);
    }
    const text = content.toString("utf8");
    validateSource(text, source.path);
    await writeFile(join(sourcesDirectory, filename), content, { flag: "wx" });
    sourceFiles.push(filename);
    sourceHashes[filename] = sha256(content);
    const identity = sourceCatalogIdentity(text, source.path);
    sourceCatalog[filename] = {
      ...identity,
      title: identity.title,
      path: source.path,
      filename,
    };
  }

  await writeFile(
    join(root, "source-catalog.json"),
    `${JSON.stringify(sourceCatalog, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(
    join(root, "taxonomy.json"),
    `${JSON.stringify(DEFAULT_TAXONOMY, null, 2)}\n`,
    { flag: "wx" },
  );
  const currentState = await loadState(vault);
  await writeFile(
    join(root, "graph-state.json"),
    `${JSON.stringify({
      schemaVersion: currentState.schemaVersion,
      assignments: Object.fromEntries(Object.values(currentState.sources).map((source) => [
        source.sourceId,
        { primaryMoc: source.primaryMoc ?? null, secondaryMocs: source.secondaryMocs ?? [] },
      ])),
      relationships: currentState.relationships,
    }, null, 2)}\n`,
    { flag: "wx" },
  );

  const liveWikiHashes: Record<string, string> = {};
  await copyLiveWiki(vault, join(vault, "Wiki"), join(root, "wiki"), liveWikiHashes);
  const relationships = await wikiRelationships(root);
  const manifest = calculateIncrementalManifest({
    sourceHashes,
    wikiHashes: liveWikiHashes,
    pageSources: relationships.pageSources,
    pageLinks: relationships.pageLinks,
    previous: await loadPreviousManifest(input.previousCompilerRoot),
    rebuild: input.rebuild === true,
  });
  await mkdir(join(root, ".ckb-compiler"), { recursive: true });
  await writeFile(
    join(root, "incremental-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  return { root, sourceFiles, sourceHashes, liveWikiHashes, manifest, sourceCatalog };
}
