import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeWorkspace, locateWorkspace } from "../../src/index.js";

describe("workspace", () => {
  it("previews initialization without writing", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-vault-"));

    const preview = await initializeWorkspace({ vault, dryRun: true });

    expect(preview.dryRun).toBe(true);
    expect(preview.created).toContain(".ckb/config.json");
    await expect(access(join(vault, ".ckb"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the workspace without replacing existing files", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-vault-"));
    await mkdir(join(vault, "Wiki"));
    await writeFile(join(vault, "Home.md"), "# Existing home\n");

    const result = await initializeWorkspace({ vault, dryRun: false });

    expect(result.created).toContain(".ckb/config.json");
    expect(await readFile(join(vault, "Home.md"), "utf8")).toBe("# Existing home\n");
    expect(await locateWorkspace(join(vault, "Wiki"))).toBe(resolve(vault));
    expect(JSON.parse(await readFile(join(vault, ".ckb/config.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      vaultPath: resolve(vault),
      tombstoneRetentionDays: 90,
      gitCheckpoint: false,
    });
    expect(JSON.parse(await readFile(join(vault, ".ckb/state.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      relationships: {},
    });
    expect(await readFile(join(vault, "System/Taxonomy.md"), "utf8"))
      .toContain("## Thinking and Frameworks");
  });

  it("is idempotent after the first initialization", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-vault-"));
    await initializeWorkspace({ vault, dryRun: false });

    const second = await initializeWorkspace({ vault, dryRun: false });

    expect(second.created).toEqual([]);
    expect(second.preserved).toContain(".ckb/config.json");
  });
});
