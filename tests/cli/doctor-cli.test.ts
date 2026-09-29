import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeWorkspace } from "../../src/index.js";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "dist/cli/main.js");

describe("doctor CLI", () => {
  it("returns structured dependency diagnostics without requiring a Notes probe", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-doctor-cli-"));
    await initializeWorkspace({ vault, dryRun: false });
    const configPath = join(vault, ".ckb/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      extractor: { executable: string };
    };
    config.extractor.executable = "/definitely/missing/notes-export";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const output = await execFileAsync(process.execPath, [
      cliPath,
      "doctor",
      "--vault",
      vault,
      "--no-notes-probe",
    ]);
    const result = JSON.parse(output.stdout) as {
      healthy: boolean;
      checks: Array<{ id: string; status: string }>;
    };

    expect(result.healthy).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: "apple_notes_exporter", status: "fail" }),
    );
  });
});
