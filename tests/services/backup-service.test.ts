import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackupService } from "../../src/index.js";

describe("backup service", () => {
  it("copies a directory and verifies a deterministic SHA-256 manifest", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ckb-backup-"));
    const source = join(parent, "Knowledge");
    const destination = join(parent, "Backup", "Knowledge");
    await mkdir(join(source, "Notes"), { recursive: true });
    await writeFile(join(source, "Home.md"), "# Home\n");
    await writeFile(join(source, "Notes", "Example Thinker.md"), "# Example Thinker\n");

    const result = await new BackupService().copyVerified({ source, destination });

    expect(result.manifest.entries.map((entry) => entry.path)).toEqual(["Home.md", "Notes/Example Thinker.md"]);
    expect(result.manifest.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(destination, "Notes/Example Thinker.md"), "utf8")).toBe("# Example Thinker\n");
    await expect(new BackupService().verify(destination, result.manifest)).resolves.toBe(true);
  });

  it("rejects symlinks and a changed backup", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ckb-backup-"));
    const source = join(parent, "Knowledge");
    await mkdir(source);
    await writeFile(join(source, "Home.md"), "# Home\n");
    const manifest = await new BackupService().manifest(source);
    await writeFile(join(source, "Home.md"), "# Changed\n");
    await expect(new BackupService().verify(source, manifest)).resolves.toBe(false);
    await symlink(join(source, "Home.md"), join(source, "linked.md"));
    await expect(new BackupService().manifest(source)).rejects.toThrow(/symlink/i);
  });
});
