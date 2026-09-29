import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CkbConfigSchema } from "../config/schema.js";
import { InvalidWorkspaceError } from "../core/errors.js";
import { calculateGraphMetrics, type GraphMetrics } from "../graph/metrics.js";
import { DEFAULT_TAXONOMY } from "../graph/taxonomy.js";
import { extractWikilinkTargets, validateRenderedGraph } from "../graph/validate.js";
import type { RenderedGraphPage } from "../graph/render.js";
import { loadState } from "../state/state-store.js";
import { BackupService, type BackupManifest } from "./backup-service.js";

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  digest: HashSchema,
  entries: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: HashSchema })),
});

const ValidationSchema = z.object({
  presentSources: z.number().int().nonnegative(),
  assignedSources: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  links: z.number().int().nonnegative(),
  eligibleIsolates: z.array(z.string()),
  metrics: z.object({
    nodes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    components: z.number().int().nonnegative(),
    isolates: z.array(z.string()),
    degreeDistribution: z.array(z.number().int().nonnegative()),
    highestDegree: z.array(z.object({ path: z.string(), degree: z.number().int().nonnegative() })),
  }),
});

const SealSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  currentVault: z.string(),
  stagingVault: z.string(),
  currentManifest: ManifestSchema,
  stagingManifest: ManifestSchema,
  validation: ValidationSchema,
  promotedManifest: ManifestSchema.optional(),
  backupPath: z.string().optional(),
});

export type RebuildValidation = z.infer<typeof ValidationSchema>;
export type RebuildSeal = z.infer<typeof SealSchema>;

function sealPath(stagingVault: string): string {
  return `${resolve(stagingVault)}.ckb-rebuild-seal.json`;
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function requirePlainDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    throw new InvalidWorkspaceError(`${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (metadata.isSymbolicLink()) throw new InvalidWorkspaceError(`${label} cannot be a symlink`);
  if (!metadata.isDirectory()) throw new InvalidWorkspaceError(`${label} must be a directory`);
}

async function markdownPages(vault: string): Promise<RenderedGraphPage[]> {
  const pages: RenderedGraphPage[] = [];
  const addFile = async (absolute: string): Promise<void> => {
    pages.push({
      path: relative(vault, absolute).split(sep).join("/"),
      content: await readFile(absolute, "utf8"),
    });
  };
  await addFile(join(vault, "Home.md")).catch((error: unknown) => {
    throw new InvalidWorkspaceError(`Staging graph has no Home.md: ${error instanceof Error ? error.message : String(error)}`);
  });
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new InvalidWorkspaceError(`Staging graph contains a symlink: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md")) await addFile(absolute);
    }
  };
  for (const directory of ["Domains", "MOCs", "Notes", "Wiki"]) await visit(join(vault, directory));
  return pages.sort((left, right) => left.path.localeCompare(right.path));
}

async function validateStaging(vault: string): Promise<RebuildValidation> {
  const config = CkbConfigSchema.parse(JSON.parse(await readFile(join(vault, ".ckb/config.json"), "utf8")));
  const state = await loadState(vault);
  const pages = await markdownPages(vault);
  const validation = validateRenderedGraph(pages);
  const pagePaths = new Set(pages.map((page) => page.path));
  const present = Object.values(state.sources).filter((source) => source.censusStatus === "present");
  const knownMocs = new Set(DEFAULT_TAXONOMY.mocs.map((moc) => moc.slug));
  const unassigned = present.filter((source) => !source.primaryMoc || !knownMocs.has(source.primaryMoc));
  if (unassigned.length > 0) {
    throw new InvalidWorkspaceError(`Staging graph has ${unassigned.length} unassigned present source${unassigned.length === 1 ? "" : "s"}`);
  }
  const absent = present.filter((source) => !source.path.startsWith("Notes/") || !pagePaths.has(source.path));
  if (absent.length > 0) throw new InvalidWorkspaceError(`Staging graph is missing ${absent.length} first-class source page${absent.length === 1 ? "" : "s"}`);
  const hashNamed = pages.filter((page) => /apple-note-[0-9a-f]{8,}/i.test(page.path));
  if (hashNamed.length > 0) throw new InvalidWorkspaceError("Staging graph contains hash-named source pages");

  const home = pages.find((page) => page.path === "Home.md")!;
  const expectedHome = DEFAULT_TAXONOMY.domains.map((domain) => `Domains/${domain.title}`).sort();
  const actualHome = [...new Set(
    extractWikilinkTargets(home.content).filter((target) => target.startsWith("Domains/")),
  )].sort();
  if (JSON.stringify(actualHome) !== JSON.stringify(expectedHome)) {
    throw new InvalidWorkspaceError("Home.md must link to exactly the eight approved domains");
  }
  for (const page of pages.filter((candidate) => candidate.path.startsWith("MOCs/"))) {
    const sourceChildren = extractWikilinkTargets(page.content).filter((target) => target.startsWith("Notes/"));
    if (sourceChildren.length > config.graph.mocDirectChildLimit) {
      throw new InvalidWorkspaceError(`${page.path} exceeds the direct source-child limit`);
    }
  }
  const metrics: GraphMetrics = calculateGraphMetrics(pages);
  const presentPaths = new Set(present.map((source) => source.path));
  const eligibleIsolates = metrics.isolates.filter((path) => presentPaths.has(path));
  if (eligibleIsolates.length > 0) {
    throw new InvalidWorkspaceError(`Staging graph has ${eligibleIsolates.length} eligible source isolate${eligibleIsolates.length === 1 ? "" : "s"}`);
  }
  for (const wiki of Object.values(state.wikiSynthesis)) {
    const page = pages.find((candidate) => candidate.path === wiki.path);
    if (!page) throw new InvalidWorkspaceError(`Staging graph is missing Wiki synthesis ${wiki.path}`);
    for (const sourceId of wiki.sourceIds) {
      const source = present.find((candidate) => candidate.sourceId === sourceId);
      if (!source || !extractWikilinkTargets(page.content).includes(source.path.replace(/\.md$/, ""))) {
        throw new InvalidWorkspaceError(`Wiki synthesis ${wiki.path} is missing readable source provenance`);
      }
    }
  }
  return {
    presentSources: present.length,
    assignedSources: present.length - unassigned.length,
    pages: pages.length,
    links: validation.links,
    eligibleIsolates,
    metrics,
  };
}

export interface RebuildServiceDependencies {
  now?: () => Date;
  backups?: BackupService;
}

export class RebuildService {
  private readonly now: () => Date;
  private readonly backups: BackupService;

  public constructor(dependencies: RebuildServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.backups = dependencies.backups ?? new BackupService();
  }

  private async paths(currentVault: string, stagingVault: string): Promise<{ current: string; staging: string }> {
    const current = resolve(currentVault);
    const staging = resolve(stagingVault);
    if (current === staging || isWithin(current, staging) || isWithin(staging, current)) {
      throw new InvalidWorkspaceError("The staging vault must be separate from the current vault");
    }
    await requirePlainDirectory(current, "Current vault");
    await requirePlainDirectory(staging, "Staging vault");
    return { current, staging };
  }

  public async seal(input: { currentVault: string; stagingVault: string }): Promise<RebuildSeal> {
    const { current, staging } = await this.paths(input.currentVault, input.stagingVault);
    const seal: RebuildSeal = {
      schemaVersion: 1,
      createdAt: this.now().toISOString(),
      currentVault: current,
      stagingVault: staging,
      currentManifest: await this.backups.manifest(current),
      stagingManifest: await this.backups.manifest(staging),
      validation: await validateStaging(staging),
    };
    await writeFile(sealPath(staging), `${JSON.stringify(seal, null, 2)}\n`, { flag: "w" });
    return seal;
  }

  public async promote(input: { currentVault: string; stagingVault: string; backupRoot: string }): Promise<{
    backupPath: string;
    promotedManifest: BackupManifest;
    validation: RebuildValidation;
  }> {
    const { current, staging } = await this.paths(input.currentVault, input.stagingVault);
    const sealFile = sealPath(staging);
    const seal = SealSchema.parse(JSON.parse(await readFile(sealFile, "utf8")));
    if (seal.currentVault !== current || seal.stagingVault !== staging) {
      throw new InvalidWorkspaceError("Rebuild seal targets do not match the requested vaults");
    }
    if (!(await this.backups.verify(current, seal.currentManifest))) {
      throw new InvalidWorkspaceError("Current vault changed after the rebuild seal");
    }
    if (!(await this.backups.verify(staging, seal.stagingManifest))) {
      throw new InvalidWorkspaceError("Staging vault changed after the rebuild seal");
    }
    const validation = await validateStaging(staging);
    if (JSON.stringify(validation) !== JSON.stringify(seal.validation)) {
      throw new InvalidWorkspaceError("Staging validation changed after the rebuild seal");
    }
    const currentMetadata = await lstat(current);
    const stagingMetadata = await lstat(staging);
    if (currentMetadata.dev !== stagingMetadata.dev) {
      throw new InvalidWorkspaceError("Atomic promotion requires current and staging vaults on the same filesystem");
    }
    const stamp = this.now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const backupPath = join(resolve(input.backupRoot), stamp, basename(current));
    try {
      await lstat(backupPath);
      throw new InvalidWorkspaceError(`Vault backup path already exists: ${backupPath}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(backupPath), { recursive: true });
    const configPath = join(staging, ".ckb/config.json");
    const originalConfig = await readFile(configPath, "utf8");
    const parsedConfig = CkbConfigSchema.parse(JSON.parse(originalConfig));
    await writeFile(configPath, `${JSON.stringify({ ...parsedConfig, vaultPath: current }, null, 2)}\n`);
    const promotedManifest = await this.backups.manifest(staging);
    const promotedSeal: RebuildSeal = { ...seal, promotedManifest, backupPath };
    await writeFile(sealFile, `${JSON.stringify(promotedSeal, null, 2)}\n`);
    let displaced = false;
    try {
      await rename(current, backupPath);
      displaced = true;
      if (!(await this.backups.verify(backupPath, seal.currentManifest))) {
        throw new InvalidWorkspaceError("Promoted vault backup failed manifest verification");
      }
      await rename(staging, current);
      displaced = false;
      await writeFile(join(dirname(backupPath), "rebuild-seal.json"), `${JSON.stringify(promotedSeal, null, 2)}\n`);
      return { backupPath, promotedManifest, validation };
    } catch (error: unknown) {
      if (displaced) await rename(backupPath, current).catch(() => undefined);
      if (await lstat(staging).catch(() => null)) await writeFile(configPath, originalConfig).catch(() => undefined);
      throw error;
    }
  }

  public async rollback(input: {
    currentVault: string;
    backupVault: string;
    failedVaultRoot: string;
  }): Promise<{
    displacedVaultPath: string;
    restoredManifest: BackupManifest;
    displacedManifest: BackupManifest;
    currentChangedSincePromotion: boolean;
  }> {
    const current = resolve(input.currentVault);
    const backup = resolve(input.backupVault);
    const failedRoot = resolve(input.failedVaultRoot);
    if (current === backup || isWithin(current, backup) || isWithin(backup, current)) {
      throw new InvalidWorkspaceError("The rollback backup must be separate from the current vault");
    }
    if (
      isWithin(current, failedRoot)
      || isWithin(failedRoot, current)
      || isWithin(backup, failedRoot)
      || isWithin(failedRoot, backup)
    ) {
      throw new InvalidWorkspaceError("The rollback recovery directory must be separate from both vaults");
    }
    await requirePlainDirectory(current, "Current vault");
    await requirePlainDirectory(backup, "Rollback backup");

    const receiptPath = join(dirname(backup), "rebuild-seal.json");
    const seal = SealSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
    if (seal.currentVault !== current || seal.backupPath !== backup || !seal.promotedManifest) {
      throw new InvalidWorkspaceError("Rollback backup does not match a completed promotion receipt");
    }
    if (!(await this.backups.verify(backup, seal.currentManifest))) {
      throw new InvalidWorkspaceError("Rollback backup failed its original manifest verification");
    }

    const displacedManifest = await this.backups.manifest(current);
    const currentChangedSincePromotion = !(await this.backups.verify(current, seal.promotedManifest));
    const currentMetadata = await lstat(current);
    const backupMetadata = await lstat(backup);
    if (currentMetadata.dev !== backupMetadata.dev) {
      throw new InvalidWorkspaceError("Atomic rollback requires the current and backup vaults on the same filesystem");
    }

    const stamp = this.now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const displacedVaultPath = join(failedRoot, stamp, basename(current));
    try {
      await lstat(displacedVaultPath);
      throw new InvalidWorkspaceError(`Rollback recovery path already exists: ${displacedVaultPath}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(displacedVaultPath), { recursive: true });

    let currentMoved = false;
    let backupMoved = false;
    try {
      await rename(current, displacedVaultPath);
      currentMoved = true;
      await rename(backup, current);
      backupMoved = true;
      if (!(await this.backups.verify(current, seal.currentManifest))) {
        throw new InvalidWorkspaceError("Restored vault failed manifest verification");
      }
      const restoredManifest = await this.backups.manifest(current);
      await writeFile(
        join(dirname(displacedVaultPath), "rollback-receipt.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          createdAt: this.now().toISOString(),
          currentVault: current,
          restoredFrom: backup,
          displacedVaultPath,
          restoredManifest,
          displacedManifest,
          currentChangedSincePromotion,
        }, null, 2)}\n`,
      );
      return { displacedVaultPath, restoredManifest, displacedManifest, currentChangedSincePromotion };
    } catch (error: unknown) {
      if (backupMoved) await rename(current, backup).catch(() => undefined);
      if (currentMoved) await rename(displacedVaultPath, current).catch(() => undefined);
      throw error;
    }
  }
}
