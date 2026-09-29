import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const auditScript = fileURLToPath(
  new URL("../../scripts/audit-public-tree.mjs", import.meta.url),
);

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ckb-public-audit-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

async function audit(root: string) {
  try {
    const result = await execFileAsync(process.execPath, [auditScript, root]);
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as {
      code: number;
      stdout: string;
      stderr: string;
    };
    return {
      status: failure.code,
      stdout: failure.stdout,
      stderr: failure.stderr,
    };
  }
}

describe("public repository privacy audit", () => {
  it("accepts a clean synthetic repository", async () => {
    const root = await repository({
      "README.md": "# Example\n\nSynthetic documentation.\n",
      "src/index.ts": "export const value = 1;\n",
    });

    const result = await audit(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Public-tree audit passed");
  });

  it("rejects personal absolute paths", async () => {
    const privatePath = ["", "Users", "private-person", "Documents", "Knowledge"].join("/");
    const root = await repository({
      "README.md": `Use ${privatePath}.\n`,
    });

    const result = await audit(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("README.md");
    expect(result.stderr).toContain("absolute macOS user path");
  });

  it("rejects Apple Notes databases", async () => {
    const root = await repository({
      "fixtures/NoteStore.sqlite": "synthetic database placeholder",
    });

    const result = await audit(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fixtures/NoteStore.sqlite");
    expect(result.stderr).toContain("forbidden private-data path");
  });

  it("rejects credential-shaped content", async () => {
    const syntheticToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
    const root = await repository({
      "config.txt": `token=${syntheticToken}\n`,
    });

    const result = await audit(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("config.txt");
    expect(result.stderr).toContain("credential-shaped content");
  });

  it("allows only the documented redaction-test fixture", async () => {
    const syntheticToken = ["sk-proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const root = await repository({
      "tests/security/sensitivity.test.ts":
        `OPENAI_API_KEY=${syntheticToken}\n`,
    });

    const result = await audit(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Allowed synthetic credential fixtures: 1",
    );
  });
});
