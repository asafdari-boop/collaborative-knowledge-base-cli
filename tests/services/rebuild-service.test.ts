import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CkbConfigSchema,
  DEFAULT_TAXONOMY,
  RebuildService,
  initializeWorkspace,
  loadState,
  renderKnowledgeGraph,
  saveState,
} from "../../src/index.js";

async function graphVault(path: string, marker: string): Promise<void> {
  await initializeWorkspace({ vault: path, dryRun: false });
  const state = await loadState(path);
  const noteHash = "a".repeat(64);
  state.sources[noteHash] = {
    sourceId: `apple-note:${noteHash}`,
    noteIdHash: noteHash,
    path: "Notes/Investments.md",
    title: "Investments",
    aliases: [],
    account: "iCloud",
    folder: "Notes",
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    attachmentHashes: [],
    censusStatus: "present",
    missingCensusCount: 0,
    primaryMoc: "investments",
    secondaryMocs: [],
    syncStatus: "clean",
  };
  await saveState(path, state);
  const graph = renderKnowledgeGraph({
    taxonomy: DEFAULT_TAXONOMY,
    sources: [state.sources[noteHash]!],
    assignments: [{ sourceId: `apple-note:${noteHash}`, primaryMoc: "investments", secondaryMocs: [] }],
    relationships: [],
    wikiPages: [],
    mocDirectChildLimit: 50,
  });
  for (const page of graph.pages) {
    await mkdir(join(path, page.path, ".."), { recursive: true });
    await writeFile(join(path, page.path), page.content);
  }
  await writeFile(join(path, "Notes/Investments.md"), `# Investments\n\n${graph.sourceConnections[0]!.content}`);
  await writeFile(join(path, "System/Marker.md"), `${marker}\n`);
}

describe("rebuild service", () => {
  it("seals, revalidates, backs up, and promotes at the permanent path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ckb-rebuild-"));
    const current = join(parent, "Knowledge");
    const staging = join(parent, "Knowledge-Rebuild");
    const backupRoot = join(parent, "Backups");
    await graphVault(current, "Old");
    await graphVault(staging, "New");
    const service = new RebuildService({ now: () => new Date("2026-09-13T01:02:03.000Z") });
    const seal = await service.seal({ currentVault: current, stagingVault: staging });

    expect(seal.validation).toMatchObject({ presentSources: 1, assignedSources: 1, eligibleIsolates: [] });
    const result = await service.promote({ currentVault: current, stagingVault: staging, backupRoot });

    expect(await readFile(join(current, "System/Marker.md"), "utf8")).toContain("New");
    expect(await readFile(join(result.backupPath, "System/Marker.md"), "utf8")).toContain("Old");
    const config = CkbConfigSchema.parse(JSON.parse(await readFile(join(current, ".ckb/config.json"), "utf8")));
    expect(config.vaultPath).toBe(current);
    await expect(access(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows Home to link to synthesis pages in addition to the eight approved domains", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ckb-rebuild-home-synthesis-"));
    const current = join(parent, "Knowledge");
    const staging = join(parent, "Knowledge-Rebuild");
    await graphVault(current, "Old");
    await graphVault(staging, "New");
    await mkdir(join(staging, "Wiki"), { recursive: true });
    await writeFile(join(staging, "Wiki/Investment Operating System.md"), [
      "# Investment Operating System",
      "",
      "Built from [[Notes/Investments|Investments]].",
      "",
    ].join("\n"));
    await writeFile(
      join(staging, "Home.md"),
      `${await readFile(join(staging, "Home.md"), "utf8")}\n## Syntheses\n\n- [[Wiki/Investment Operating System|Investment Operating System]]\n`,
    );

    const seal = await new RebuildService().seal({ currentVault: current, stagingVault: staging });

    expect(seal.validation.presentSources).toBe(1);
  });

  it("rolls back a promoted vault while preserving the replacement for recovery", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ckb-rebuild-rollback-"));
    const current = join(parent, "Knowledge");
    const staging = join(parent, "Knowledge-Rebuild");
    const backupRoot = join(parent, "Backups");
    const failedVaultRoot = join(parent, "Recovery");
    await graphVault(current, "Old");
    await graphVault(staging, "New");
    const service = new RebuildService({ now: () => new Date("2026-09-13T01:02:03.000Z") });
    await service.seal({ currentVault: current, stagingVault: staging });
    const promotion = await service.promote({ currentVault: current, stagingVault: staging, backupRoot });

    const rollback = await service.rollback({
      currentVault: current,
      backupVault: promotion.backupPath,
      failedVaultRoot,
    });

    expect(await readFile(join(current, "System/Marker.md"), "utf8")).toContain("Old");
    expect(await readFile(join(rollback.displacedVaultPath, "System/Marker.md"), "utf8")).toContain("New");
    await expect(access(promotion.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(rollback.restoredManifest).toEqual(expect.objectContaining({ schemaVersion: 1 }));
    expect(rollback.displacedManifest).toEqual(expect.objectContaining({ schemaVersion: 1 }));
  });

  it("refuses promotion if either the current vault or staging vault changed after sealing", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ckb-rebuild-stale-"));
    const current = join(parent, "Knowledge");
    const staging = join(parent, "Knowledge-Rebuild");
    await graphVault(current, "Old");
    await graphVault(staging, "New");
    const service = new RebuildService();
    await service.seal({ currentVault: current, stagingVault: staging });
    await writeFile(join(staging, "System/Marker.md"), "Changed after seal\n");

    await expect(service.promote({
      currentVault: current,
      stagingVault: staging,
      backupRoot: join(parent, "Backups"),
    })).rejects.toThrow(/changed after.*seal/i);
    expect(await readFile(join(current, "System/Marker.md"), "utf8")).toContain("Old");
  });

  it("refuses to seal a graph with an unassigned present source", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ckb-rebuild-invalid-"));
    const current = join(parent, "Knowledge");
    const staging = join(parent, "Knowledge-Rebuild");
    await graphVault(current, "Old");
    await graphVault(staging, "New");
    const state = await loadState(staging);
    delete state.sources["a".repeat(64)]!.primaryMoc;
    await saveState(staging, state);

    await expect(new RebuildService().seal({ currentVault: current, stagingVault: staging }))
      .rejects.toThrow(/unassigned/i);
  });
});
