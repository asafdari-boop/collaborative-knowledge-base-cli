import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getObject, initializeWorkspace, putObject } from "../../src/index.js";

describe("object store", () => {
  it("deduplicates immutable content by hash", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-objects-"));
    await initializeWorkspace({ vault, dryRun: false });

    const first = await putObject(vault, "same revision\n");
    const second = await putObject(vault, "same revision\n");

    expect(first).toBe(second);
    expect(await getObject(vault, first)).toBe("same revision\n");
  });

  it("rejects an object whose bytes no longer match its name", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-objects-"));
    await initializeWorkspace({ vault, dryRun: false });
    const hash = await putObject(vault, "original\n");
    await writeFile(join(vault, ".ckb/objects", hash), "corrupt\n");

    await expect(getObject(vault, hash)).rejects.toMatchObject({
      code: "object_hash_mismatch",
    });
  });

  it("rejects an invalid object address", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-objects-"));
    await initializeWorkspace({ vault, dryRun: false });

    await expect(getObject(vault, "../state.json")).rejects.toMatchObject({
      code: "invalid_object_hash",
    });
  });
});
