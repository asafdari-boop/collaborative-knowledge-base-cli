import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CkbConfigSchema,
  FixtureNotesExtractor,
  LocalAuditService,
  initializeWorkspace,
} from "../../src/index.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/apple-notes");

describe("local Notes audit", () => {
  it("reports aggregate locally normalized coverage without changing the vault", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-audit-vault-"));
    await initializeWorkspace({ vault, dryRun: false });
    const stateBefore = await readFile(join(vault, ".ckb/state.json"), "utf8");
    const config = CkbConfigSchema.parse({
      schemaVersion: 1,
      vaultPath: vault,
      extractor: { maximumNoteCount: 20 },
    });

    const result = await new LocalAuditService({
      extractor: new FixtureNotesExtractor(fixtureRoot),
    }).audit({ vault, config });

    expect(result).toMatchObject({
      noteCount: 7,
      compilerEligible: 5,
      excluded: 1,
      inaccessible: 1,
      truncated: 0,
      redactions: 0,
      attachmentFilesPlanned: 1,
      riskCategories: { credentials: 1 },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("A durable idea");
    expect(serialized).not.toContain("x-coredata://");
    expect(await readdir(join(vault, "Sources/Apple Notes"))).toEqual([]);
    expect(await readdir(join(vault, "Attachments"))).toEqual([]);
    expect(await readdir(join(vault, "Wiki"))).toEqual([]);
    expect(await readdir(join(vault, "Reviews"))).toEqual([]);
    expect(await readFile(join(vault, ".ckb/state.json"), "utf8")).toBe(stateBefore);
  });
});
