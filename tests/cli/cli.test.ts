import { execFile } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "dist/cli/main.js");

describe("ckb CLI", () => {
  it("previews initialization, initializes, and reports empty status", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ckb-cli-"));
    const vault = join(parent, "Knowledge");

    const preview = await execFileAsync(process.execPath, [cliPath, "init", "--vault", vault, "--dry-run"]);
    expect(JSON.parse(preview.stdout)).toMatchObject({ dryRun: true, vault });
    await expect(access(vault)).rejects.toMatchObject({ code: "ENOENT" });

    await execFileAsync(process.execPath, [cliPath, "init", "--vault", vault]);
    const status = await execFileAsync(process.execPath, [cliPath, "status", "--vault", vault]);
    expect(JSON.parse(status.stdout)).toMatchObject({
      workspace: { pages: 0, sources: 0, pendingReviews: 0, locked: false },
      extraction: null,
      compilation: null,
      dependencies: { appleNotesExporter: { probed: false } },
    });

    const reviews = await execFileAsync(process.execPath, [
      cliPath,
      "review",
      "list",
      "--vault",
      vault,
    ]);
    expect(JSON.parse(reviews.stdout)).toEqual([]);
  });
});
