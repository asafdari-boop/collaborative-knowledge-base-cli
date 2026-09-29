import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeWorkspace } from "../../src/index.js";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "dist/cli/main.js");

describe("refresh CLI", () => {
  it("exposes refresh, downstream diff, and upstream-only diff without vault writes", async () => {
    const help = await execFileAsync(process.execPath, [cliPath, "--help"]);
    expect(help.stdout).toContain("refresh");
    expect(help.stdout).toContain("diff");
    expect(help.stdout).toContain("upstream-diff");
    expect(help.stdout).toContain("query");
    expect(help.stdout).toContain("rebuild");
    const refreshHelp = await execFileAsync(process.execPath, [cliPath, "refresh", "--help"]);
    expect(refreshHelp.stdout).toContain("--use-fallback");
    expect(refreshHelp.stdout).toContain("--rebuild");
    expect(refreshHelp.stdout).toContain("--graph-plan");
    const upstreamHelp = await execFileAsync(process.execPath, [
      cliPath,
      "upstream-diff",
      "--help",
    ]);
    expect(upstreamHelp.stdout).toContain("--vault");
    expect(upstreamHelp.stdout).toContain("without invoking a model");
    const queryHelp = await execFileAsync(process.execPath, [cliPath, "query", "--help"]);
    expect(queryHelp.stdout).toContain("<question>");
    expect(queryHelp.stdout).toContain("--vault");
    const rebuildHelp = await execFileAsync(process.execPath, [cliPath, "rebuild", "--help"]);
    expect(rebuildHelp.stdout).toContain("--staging");
    expect(rebuildHelp.stdout).toContain("--backup-root");
    expect(rebuildHelp.stdout).toContain("--promote");
    expect(rebuildHelp.stdout).toContain("--seal-only");

    const vault = await mkdtemp(join(tmpdir(), "ckb-refresh-cli-"));
    await initializeWorkspace({ vault, dryRun: false });
    const configPath = join(vault, ".ckb/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      extractor: { executable: string };
    };
    config.extractor.executable = "/definitely/missing/notes-export";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const stateBefore = await readFile(join(vault, ".ckb/state.json"), "utf8");

    const failure = await execFileAsync(process.execPath, [
      cliPath,
      "refresh",
      "--vault",
      vault,
      "--dry-run",
    ]).catch((error: unknown) => error as { stderr: string });

    expect(JSON.parse(failure.stderr)).toMatchObject({ code: "dependency_unavailable" });
    const upstreamFailure = await execFileAsync(process.execPath, [
      cliPath,
      "upstream-diff",
      "--vault",
      vault,
    ]).catch((error: unknown) => error as { stderr: string });
    expect(JSON.parse(upstreamFailure.stderr)).toMatchObject({ code: "dependency_unavailable" });
    expect(await readdir(join(vault, "Sources/Apple Notes"))).toEqual([]);
    expect(await readdir(join(vault, "Wiki"))).toEqual([]);
    expect(await readFile(join(vault, ".ckb/state.json"), "utf8")).toBe(stateBefore);
  });

  it("fails before extraction when manual fallback was not configured", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-refresh-cli-fallback-"));
    await initializeWorkspace({ vault, dryRun: false });
    const failure = await execFileAsync(process.execPath, [
      cliPath,
      "refresh",
      "--vault",
      vault,
      "--dry-run",
      "--use-fallback",
    ]).catch((error: unknown) => error as { stderr: string });
    expect(JSON.parse(failure.stderr)).toMatchObject({
      code: "compiler_validation_failed",
      message: "No manual fallback compiler is configured",
    });
  });
});
