import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexCommand } from "../../src/compiler/codex-command.js";

describe("Codex command", () => {
  it("builds a confined noninteractive saved-login invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ckb-codex-command-"));
    const command = buildCodexCommand({
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      root,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      schemaPath: join(root, "run-report.schema.json"),
      reportPath: join(root, "run-report.json"),
    });

    expect(command.executable).toBe("/Applications/ChatGPT.app/Contents/Resources/codex");
    expect(command.args).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--json",
      "-C",
      root,
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      "--output-schema",
      join(root, "run-report.schema.json"),
      "-o",
      join(root, "run-report.json"),
      "Read CKB_INSTRUCTIONS.md and perform the requested knowledge-base compilation exactly.",
    ]);
  });

  it("rejects schema and report paths outside the disposable project", async () => {
    const root = await mkdtemp(join(tmpdir(), "ckb-codex-command-"));
    expect(() => buildCodexCommand({
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      root,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      schemaPath: "/tmp/outside-schema.json",
      reportPath: join(root, "run-report.json"),
    })).toThrow(/inside/i);
  });
});
