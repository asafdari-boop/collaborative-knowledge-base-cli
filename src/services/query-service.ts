import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { CompilerValidationError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { resolveInside } from "../core/paths.js";
import { buildCodexQueryCommand } from "../compiler/codex-query-command.js";
import { runProcess, type ProcessRunner } from "../extractors/process-runner.js";
import type { CodexAdapterConfig } from "../compiler/codex-adapter.js";
import { extractWikilinkTargets } from "../graph/validate.js";

async function vaultSnapshot(vault: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(vault, absolute).split(sep).join("/");
      if (path === ".obsidian" || path.startsWith(".obsidian/")) continue;
      if (entry.isSymbolicLink()) throw new CompilerValidationError(`Vault contains a symlink: ${path}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) hashes.set(path, sha256(await readFile(absolute)));
    }
  };
  await visit(vault);
  return hashes;
}

function sameSnapshot(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  return [...left].every(([path, hash]) => right.get(path) === hash);
}

async function validateCitations(vault: string, answer: string): Promise<void> {
  const targets = extractWikilinkTargets(answer);
  if (targets.length === 0) throw new CompilerValidationError("Codex query answer has no vault citation");
  for (const target of new Set(targets)) {
    const candidates = target.endsWith(".md") ? [target] : [`${target}.md`, target];
    let found = false;
    for (const candidate of candidates) {
      try {
        const metadata = await lstat(resolveInside(vault, candidate));
        if (metadata.isFile()) {
          found = true;
          break;
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!found) throw new CompilerValidationError(`Codex query answer cites a missing page: [[${target}]]`);
  }
}

export interface QueryInput {
  vault: string;
  question: string;
  signal?: AbortSignal;
}

export class QueryService {
  public constructor(
    private readonly config: CodexAdapterConfig,
    private readonly runner: ProcessRunner = runProcess,
  ) {}

  public async ask(input: QueryInput): Promise<string> {
    const vault = resolve(input.vault);
    const temporary = await mkdtemp(join(tmpdir(), "ckb-query-"));
    const outputPath = join(temporary, "answer.md");
    const before = await vaultSnapshot(vault);
    try {
      const command = buildCodexQueryCommand({
        ...this.config,
        vault,
        outputPath,
        question: input.question,
      });
      const result = await this.runner({
        executable: command.executable,
        args: command.args,
        cwd: command.cwd,
        timeoutMs: this.config.timeoutMs ?? 30 * 60 * 1000,
        maxOutputBytes: 16 * 1024 * 1024,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (result.exitCode !== 0) {
        throw new CompilerValidationError("Codex query failed");
      }
      const answer = await readFile(outputPath, "utf8");
      if (!answer.trim()) throw new CompilerValidationError("Codex query returned an empty answer");
      await validateCitations(vault, answer);
      const after = await vaultSnapshot(vault);
      if (!sameSnapshot(before, after)) {
        throw new CompilerValidationError("Knowledge-base files changed during a read-only query");
      }
      return answer;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
