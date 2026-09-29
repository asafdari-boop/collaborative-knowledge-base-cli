import { isAbsolute, relative, resolve, sep } from "node:path";
import { CompilerValidationError } from "../core/errors.js";

export interface CodexCommandInput {
  executable: string;
  root: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  schemaPath: string;
  reportPath: string;
}

export interface CodexCommand {
  executable: string;
  args: string[];
  cwd: string;
}

function assertInside(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CompilerValidationError(`${label} must remain inside the disposable compiler project`);
  }
  return resolvedCandidate;
}

export function buildCodexCommand(input: CodexCommandInput): CodexCommand {
  if (!isAbsolute(input.executable)) {
    throw new CompilerValidationError("Codex executable must be an absolute path");
  }
  const root = resolve(input.root);
  const schemaPath = assertInside(root, input.schemaPath, "Codex output schema");
  const reportPath = assertInside(root, input.reportPath, "Codex report");
  return {
    executable: input.executable,
    cwd: root,
    args: [
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
      input.model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
      "--output-schema",
      schemaPath,
      "-o",
      reportPath,
      "Read CKB_INSTRUCTIONS.md and perform the requested knowledge-base compilation exactly.",
    ],
  };
}
