import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QueryService } from "../../src/index.js";
import type { ProcessRunner } from "../../src/index.js";

describe("query service", () => {
  it("returns a cited answer without changing the vault", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-query-service-"));
    await mkdir(join(vault, "Notes"));
    await writeFile(join(vault, "Home.md"), "# Home\n\n[[Notes/Example Thinker|Example Thinker]]\n");
    await writeFile(join(vault, "Notes/Example Thinker.md"), "# Example Thinker\n\nSpecific knowledge.\n");
    let observedSandbox: string | undefined;
    const runner: ProcessRunner = async (request) => {
      observedSandbox = request.args[request.args.indexOf("--sandbox") + 1];
      const outputPath = request.args[request.args.indexOf("-o") + 1]!;
      await writeFile(outputPath, "Develop specific knowledge. [[Notes/Example Thinker|Example Thinker]]\n");
      return { stdout: "{}\n", stderr: "", exitCode: 0, signal: null };
    };
    const before = await readFile(join(vault, "Notes/Example Thinker.md"), "utf8");

    const answer = await new QueryService({
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    }, runner).ask({ vault, question: "What should I develop?" });

    expect(observedSandbox).toBe("read-only");
    expect(answer).toContain("[[Notes/Example Thinker|Example Thinker]]");
    expect(await readFile(join(vault, "Notes/Example Thinker.md"), "utf8")).toBe(before);
  });

  it("rejects an uncited answer", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-query-service-"));
    await writeFile(join(vault, "Home.md"), "# Home\n");
    const runner: ProcessRunner = async (request) => {
      await writeFile(request.args[request.args.indexOf("-o") + 1]!, "Unsupported answer.\n");
      return { stdout: "{}\n", stderr: "", exitCode: 0, signal: null };
    };

    await expect(new QueryService({
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    }, runner).ask({ vault, question: "Question" })).rejects.toThrow(/citation/i);
  });
});
