import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { CompilerValidationError, PageIdentityMismatchError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { assertNoSymlinkAncestors } from "../core/paths.js";
import { ensurePageId, parsePage } from "../pages/frontmatter.js";
import type { CompileProposal } from "../services/collaboration-service.js";
import { loadState } from "../state/state-store.js";
import type { LlmwikiProject } from "./types.js";

const MAX_PAGE_BYTES = 600_000;
const MAX_PAGE_COUNT = 10_000;

async function collectMarkdownFiles(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CompilerValidationError(`Compiler output contains a symlink: ${path}`);
    }
    if (entry.isDirectory()) files.push(...(await collectMarkdownFiles(root, path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    else if (entry.isFile()) {
      throw new CompilerValidationError(`Compiler output contains a non-Markdown file: ${path}`);
    } else {
      throw new CompilerValidationError(`Compiler output contains an unsupported entry: ${path}`);
    }
  }
  return files;
}

async function readLivePage(vault: string, path: string): Promise<string | null> {
  const absolutePath = join(vault, ...path.split("/"));
  await assertNoSymlinkAncestors(vault, absolutePath);
  const metadata = await stat(absolutePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return null;
  if (!metadata.isFile()) throw new CompilerValidationError(`Live wiki target is not a file: ${path}`);
  return readFile(absolutePath, "utf8");
}

function scrubVolatileTimestamps(content: string): string {
  return content
    .replace(/^updatedAt:\s*.*$/gm, "updatedAt: <timestamp>")
    .replace(/\| Generated \d{4}-\d{2}-\d{2}T[^_]+_/g, "| Generated <timestamp>_");
}

function stabilizeNoop(generated: string, live: string | null): string {
  if (live !== null && scrubVolatileTimestamps(generated) === scrubVolatileTimestamps(live)) {
    return live;
  }
  return generated;
}

export function stableGeneratedPageId(content: string): string {
  const semanticContent = scrubVolatileTimestamps(content);
  return `page:auto:${sha256(`ckb-generated-page:${semanticContent}`).slice(0, 32)}`;
}

function sourceHashesForPage(
  content: string,
  project: LlmwikiProject,
  path: string,
): string[] {
  const sources = parsePage(content).attributes.sources;
  if (sources === undefined) return [];
  if (!Array.isArray(sources) || sources.some((source) => typeof source !== "string")) {
    throw new CompilerValidationError(`Compiler page has invalid sources frontmatter: ${path}`);
  }
  const hashes = new Set<string>();
  for (const source of sources as string[]) {
    if (source.includes("/") || source.includes("\\") || !source.endsWith(".md")) {
      throw new CompilerValidationError(`Compiler page cites an unsafe source name: ${source}`);
    }
    const hash = project.sourceHashes[source];
    if (!hash) throw new CompilerValidationError(`Compiler page cites a missing source: ${source}`);
    hashes.add(hash);
  }
  return [...hashes].sort();
}

export async function collectCompilerProposals(
  vault: string,
  project: LlmwikiProject,
): Promise<CompileProposal[]> {
  const wikiRoot = join(project.root, "wiki");
  const files = await collectMarkdownFiles(wikiRoot, wikiRoot);
  if (files.length > MAX_PAGE_COUNT) {
    throw new CompilerValidationError(`Compiler emitted more than ${MAX_PAGE_COUNT} pages`);
  }
  const state = await loadState(vault);
  const proposals: CompileProposal[] = [];
  const seenPaths = new Set<string>();
  const seenPageIds = new Set<string>();

  for (const file of files) {
    const relativePath = relative(wikiRoot, file).split(sep).join("/");
    const targetPath = `Wiki/${relativePath}`;
    if (seenPaths.has(targetPath)) {
      throw new CompilerValidationError(`Duplicate compiler page target: ${targetPath}`);
    }
    seenPaths.add(targetPath);
    const bytes = await readFile(file);
    if (bytes.length > MAX_PAGE_BYTES) {
      throw new CompilerValidationError(`Compiler page is too large: ${targetPath}`);
    }
    const generated = bytes.toString("utf8");
    parsePage(generated);
    const live = await readLivePage(vault, targetPath);
    const tracked = Object.values(state.pages).find((page) => page.path === targetPath);
    const liveId = live === null ? undefined : parsePage(live).id;
    if (tracked && liveId !== tracked.pageId) throw new PageIdentityMismatchError(targetPath);
    const expectedId = tracked?.pageId ?? liveId ?? stableGeneratedPageId(generated);
    const generatedId = parsePage(generated).id;
    if (generatedId && expectedId && generatedId !== expectedId) {
      throw new PageIdentityMismatchError(targetPath);
    }
    const identified = ensurePageId(generated, expectedId).content;
    const identifiedId = parsePage(identified).id;
    if (!identifiedId || seenPageIds.has(identifiedId)) {
      throw new CompilerValidationError(
        `Compiler emitted a duplicate or missing page identity: ${targetPath}`,
      );
    }
    seenPageIds.add(identifiedId);
    const content = stabilizeNoop(identified, live);
    proposals.push({
      path: targetPath,
      content,
      sourceHashes: sourceHashesForPage(content, project, targetPath),
    });
  }
  return proposals;
}

export async function verifyCompilerSources(project: LlmwikiProject): Promise<void> {
  for (const [filename, expectedHash] of Object.entries(project.sourceHashes)) {
    const content = await readFile(join(project.root, "sources", filename));
    if (sha256(content) !== expectedHash) {
      throw new CompilerValidationError(`Compiler mutated source input ${filename}`);
    }
  }
}
