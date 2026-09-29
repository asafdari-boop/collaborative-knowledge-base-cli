import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";
import { InvalidWorkspaceError } from "../core/errors.js";
import { CkbConfigSchema, type CkbConfig } from "./schema.js";
import { DEFAULT_TAXONOMY, renderTaxonomyMarkdown } from "../graph/taxonomy.js";

const workspaceDirectories = [
  "Wiki",
  "Domains",
  "MOCs",
  "Notes",
  // Retained empty for v1 workspace compatibility; v2 source pages live in Notes/.
  "Sources/Apple Notes",
  "Views",
  "System",
  "Attachments",
  "Reviews",
  ".ckb/objects",
  ".ckb/compiler",
  ".ckb/staging",
  ".ckb/tombstones",
  ".ckb/reviews/archive",
  ".ckb/recovery",
] as const;

const workspaceFiles = [
  ".ckb/config.json",
  ".ckb/state.json",
  ".ckb/journal.jsonl",
  "System/Taxonomy.md",
] as const;

export interface InitializeWorkspaceOptions {
  vault: string;
  dryRun: boolean;
}

export interface InitPlan {
  vault: string;
  dryRun: boolean;
  created: string[];
  preserved: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function initialConfig(vault: string): CkbConfig {
  return CkbConfigSchema.parse({
    schemaVersion: 2,
    vaultPath: vault,
  });
}

function initialFile(relativePath: (typeof workspaceFiles)[number], vault: string): string {
  switch (relativePath) {
    case ".ckb/config.json":
      return `${JSON.stringify(initialConfig(vault), null, 2)}\n`;
    case ".ckb/state.json":
      return `${JSON.stringify({
        schemaVersion: 2,
        pages: {},
        sources: {},
        relationships: {},
        unresolvedReferences: {},
        wikiSynthesis: {},
      }, null, 2)}\n`;
    case ".ckb/journal.jsonl":
      return "";
    case "System/Taxonomy.md":
      return renderTaxonomyMarkdown(DEFAULT_TAXONOMY);
  }
}

export async function initializeWorkspace(
  options: InitializeWorkspaceOptions,
): Promise<InitPlan> {
  const vault = resolve(options.vault);
  const entries = [...workspaceDirectories, ...workspaceFiles];
  const created: string[] = [];
  const preserved: string[] = [];

  for (const entry of entries) {
    (await exists(join(vault, entry)) ? preserved : created).push(entry);
  }

  if (options.dryRun) {
    return { vault, dryRun: true, created, preserved };
  }

  await mkdir(vault, { recursive: true });
  for (const directory of workspaceDirectories) {
    await mkdir(join(vault, directory), { recursive: true });
  }
  for (const file of workspaceFiles) {
    try {
      await writeFile(join(vault, file), initialFile(file, vault), { flag: "wx" });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  return { vault, dryRun: false, created, preserved };
}

export async function locateWorkspace(start: string): Promise<string> {
  let cursor = resolve(start);
  try {
    if (!(await stat(cursor)).isDirectory()) cursor = dirname(cursor);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const filesystemRoot = parse(cursor).root;
  while (true) {
    const configPath = join(cursor, ".ckb/config.json");
    if (await exists(configPath)) {
      const parsed = CkbConfigSchema.safeParse(
        JSON.parse(await readFile(configPath, "utf8")) as unknown,
      );
      if (!parsed.success || resolve(parsed.data.vaultPath) !== cursor) {
        throw new InvalidWorkspaceError(`Invalid workspace configuration at ${configPath}`);
      }
      return cursor;
    }
    if (cursor === filesystemRoot) break;
    cursor = dirname(cursor);
  }

  throw new InvalidWorkspaceError(
    `No .ckb/config.json found at or above ${relative(filesystemRoot, resolve(start))}`,
  );
}

export async function loadWorkspaceConfig(vaultPath: string): Promise<CkbConfig> {
  const vault = resolve(vaultPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(vault, ".ckb/config.json"), "utf8")) as unknown;
  } catch (error: unknown) {
    throw new InvalidWorkspaceError(
      `Unable to read workspace configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = CkbConfigSchema.safeParse(raw);
  if (!parsed.success || resolve(parsed.data.vaultPath) !== vault) {
    throw new InvalidWorkspaceError(`Invalid workspace configuration at ${vault}`);
  }
  return parsed.data;
}
