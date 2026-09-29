import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexQueryCommand } from "../../src/index.js";

describe("Codex query command", () => {
  it("uses the saved login in a read-only vault sandbox", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-query-vault-"));
    const outputPath = join(await mkdtemp(join(tmpdir(), "ckb-query-output-")), "answer.md");
    const command = buildCodexQueryCommand({
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      vault,
      outputPath,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      question: "What ideas should I develop next?",
    });

    expect(command.executable).toBe("/Applications/ChatGPT.app/Contents/Resources/codex");
    expect(command.cwd).toBe(vault);
    expect(command.args).toContain("read-only");
    expect(command.args).not.toContain("workspace-write");
    expect(command.args).toContain(outputPath);
    expect(command.args.at(-1)).toContain("What ideas should I develop next?");
    expect(command.args.at(-1)).toContain("[[Notes/");
  });

  it("requires an absolute Codex executable", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-query-vault-"));
    expect(() => buildCodexQueryCommand({
      executable: "codex",
      vault,
      outputPath: join(tmpdir(), "answer.md"),
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      question: "Question",
    })).toThrow(/absolute/i);
  });
});
