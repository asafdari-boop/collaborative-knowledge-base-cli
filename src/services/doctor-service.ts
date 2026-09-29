import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CkbConfig } from "../config/schema.js";
import { sha256 } from "../core/hash.js";
import { resolveInside } from "../core/paths.js";
import {
  ExporterAccountListSchema,
  parseExporterJson,
} from "../extractors/apple-notes-exporter-contract.js";
import { runProcess, type ProcessRunner } from "../extractors/process-runner.js";
import { parsePage } from "../pages/frontmatter.js";
import { listReviews } from "../reviews/review-store.js";
import { getObject } from "../state/object-store.js";
import { loadState } from "../state/state-store.js";
import { listRecoveryRecords } from "../publishing/recovery-store.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
  details?: string[];
}

export interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
}

export interface DoctorServiceDependencies {
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
}

export interface DoctorOptions {
  vault: string;
  config: CkbConfig;
  probeNotes?: boolean;
}

const PROCESS_OUTPUT_LIMIT = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15_000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function llmwikiCredentialCheck(
  compiler: Extract<CkbConfig["compiler"]["primary"], { adapter: "llmwiki" }>,
  env: NodeJS.ProcessEnv,
  id = "llm_provider_credentials",
  unavailableStatus: DoctorStatus = "fail",
): DoctorCheck {
  const provider = compiler.provider === "environment"
    ? (env.LLMWIKI_PROVIDER?.trim().toLowerCase() || "anthropic")
    : compiler.provider;
  const keys: Record<string, string[]> = {
    anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    openai: ["OPENAI_API_KEY"],
    minimax: ["MINIMAX_API_KEY"],
    copilot: ["GITHUB_TOKEN"],
  };
  if (provider === "ollama" || provider === "claude-agent") {
    return {
      id,
      status: "pass",
      message: provider === "ollama"
        ? "llmwiki is configured for the local Ollama provider."
        : "llmwiki is configured to use the local Claude Code login.",
    };
  }
  const candidates = keys[provider] ?? [`${provider.toUpperCase()}_API_KEY`];
  const present = candidates.some((key) => Boolean(env[key]?.trim()));
  return {
    id,
    status: present ? "pass" : unavailableStatus,
    message: present
      ? `Credentials are present for the ${provider} provider.`
      : `No credential was found for the ${provider} provider.`,
    ...(!present ? { details: candidates } : {}),
  };
}

async function workspaceChecks(vault: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    const state = await loadState(vault);
    for (const source of Object.values(state.sources)) {
      if (!source.generatedHash) continue;
      const content = await readFile(resolveInside(vault, source.path));
      if (sha256(content) !== source.generatedHash) {
        throw new Error(`generated source drift at ${source.path}`);
      }
    }
    for (const page of Object.values(state.pages)) {
      const live = await readFile(resolveInside(vault, page.path), "utf8");
      if (parsePage(live).id !== page.pageId) {
        throw new Error(`page identity drift at ${page.path}`);
      }
      if (page.baseHash && page.baseObjectHash) {
        const base = await getObject(vault, page.baseObjectHash);
        if (sha256(base) !== page.baseHash) throw new Error(`base drift at ${page.path}`);
      }
    }
    checks.push({
      id: "workspace_state",
      status: "pass",
      message: `Workspace state is valid (${Object.keys(state.sources).length} sources, ${Object.keys(state.pages).length} wiki pages).`,
    });
  } catch (error: unknown) {
    checks.push({
      id: "workspace_state",
      status: "fail",
      message: `Workspace state is unhealthy: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const locked = await exists(join(vault, ".ckb/lock"));
  let recoveryRecords;
  let recoveryError: unknown;
  try {
    recoveryRecords = await listRecoveryRecords(vault);
  } catch (error: unknown) {
    recoveryRecords = [];
    recoveryError = error;
  }
  checks.push({
    id: "workspace_recovery",
    status: recoveryError || locked || recoveryRecords.length > 0 ? "fail" : "pass",
    message: recoveryError
      ? `Prepared recovery state is unreadable: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
      : recoveryRecords.length > 0
      ? `${recoveryRecords.length} prepared operation${recoveryRecords.length === 1 ? " requires" : "s require"} recovery; run ckb recover before refreshing.`
      : locked
        ? "A workspace lock remains without a prepared record; inspect it before clearing anything."
      : "No interrupted workspace operation is pending.",
  });

  try {
    const reviews = await listReviews(vault);
    checks.push({
      id: "pending_reviews",
      status: reviews.length > 0 ? "warn" : "pass",
      message: reviews.length > 0
        ? `${reviews.length} human review${reviews.length === 1 ? " is" : "s are"} pending.`
        : "No human reviews are pending.",
    });
  } catch (error: unknown) {
    checks.push({
      id: "pending_reviews",
      status: "fail",
      message: `Review state is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return checks;
}

export class DoctorService {
  private readonly runner: ProcessRunner;
  private readonly env: NodeJS.ProcessEnv;

  public constructor(dependencies: DoctorServiceDependencies = {}) {
    this.runner = dependencies.runner ?? runProcess;
    this.env = dependencies.env ?? process.env;
  }

  private runExporter(config: CkbConfig, args: string[]) {
    const commandArgs = config.extractor.databasePath && args[0] !== "--version"
      ? [args[0] ?? "", "--db", config.extractor.databasePath, ...args.slice(1)]
      : args;
    return this.runner({
      executable: config.extractor.executable,
      args: commandArgs,
      timeoutMs: Math.min(config.extractor.timeoutMs, PROCESS_TIMEOUT_MS),
      maxOutputBytes: PROCESS_OUTPUT_LIMIT,
    });
  }

  public async run(options: DoctorOptions): Promise<DoctorResult> {
    const checks = await workspaceChecks(options.vault);
    const primary = options.config.compiler.primary;
    if (primary.adapter === "codex-agent") {
      try {
        const version = await this.runner({
          executable: primary.executable,
          args: ["--version"],
          timeoutMs: PROCESS_TIMEOUT_MS,
          maxOutputBytes: PROCESS_OUTPUT_LIMIT,
        });
        const login = await this.runner({
          executable: primary.executable,
          args: ["login", "status"],
          timeoutMs: PROCESS_TIMEOUT_MS,
          maxOutputBytes: PROCESS_OUTPUT_LIMIT,
        });
        const healthy = version.exitCode === 0 && login.exitCode === 0 &&
          /logged in|chatgpt/i.test(`${login.stdout}\n${login.stderr}`);
        checks.push({
          id: "codex_primary",
          status: healthy ? "pass" : "fail",
          message: healthy
            ? `Codex ${version.stdout.trim() || "CLI"} is available with a saved ChatGPT login.`
            : "Codex is unavailable or not signed in with ChatGPT.",
        });
      } catch (error: unknown) {
        checks.push({
          id: "codex_primary",
          status: "fail",
          message: `Codex is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } else {
      checks.push(llmwikiCredentialCheck(primary, this.env));
    }
    if (options.config.compiler.fallback) {
      checks.push(llmwikiCredentialCheck(
        options.config.compiler.fallback,
        this.env,
        "manual_fallback",
        "warn",
      ));
    }
    let compatible = false;
    try {
      const version = await this.runExporter(options.config, ["--version"]);
      compatible = version.exitCode === 0 && /^2(?:\.|$)/.test(version.stdout.trim());
      checks.push({
        id: "apple_notes_exporter",
        status: compatible ? "pass" : "fail",
        message: compatible
          ? `Apple Notes Exporter ${version.stdout.trim()} is compatible.`
          : `Apple Notes Exporter v2 is required; received ${version.stdout.trim() || "no valid version"}.`,
      });
    } catch (error: unknown) {
      checks.push({
        id: "apple_notes_exporter",
        status: "fail",
        message: `Apple Notes Exporter is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    if (compatible && options.probeNotes !== false) {
      const accounts = await this.runExporter(options.config, [
        "list-accounts",
        "--format",
        "json",
      ]).catch((error: unknown) => ({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: -1,
        signal: null,
      }));
      if (accounts.exitCode !== 0) {
        const permission = /full disk access|operation not permitted|not authorized|permission denied/i.test(
          accounts.stderr,
        );
        checks.push({
          id: permission ? "full_disk_access" : "apple_notes_access",
          status: "fail",
          message: permission
            ? "Apple Notes metadata is inaccessible; Full Disk Access is the likely missing permission."
            : `Apple Notes account probe failed: ${accounts.stderr.trim() || "unknown exporter error"}`,
        });
      } else {
        try {
          const parsed = parseExporterJson(
            "Account probe",
            accounts.stdout,
            ExporterAccountListSchema,
          );
          checks.push({
            id: "full_disk_access",
            status: "pass",
            message: `Apple Notes account metadata is accessible (${parsed.accounts.length} accounts).`,
          });
          const names = new Set(parsed.accounts.map((account) => account.name));
          const missing = options.config.extractor.accountAllowlist.filter(
            (account) => !names.has(account),
          );
          checks.push({
            id: "configured_accounts",
            status: missing.length === 0 ? "pass" : "fail",
            message: missing.length === 0
              ? "Every configured Apple Notes account is visible."
              : "Some configured Apple Notes accounts are not visible.",
            ...(missing.length > 0 ? { details: missing } : {}),
          });
        } catch (error: unknown) {
          checks.push({
            id: "apple_notes_access",
            status: "fail",
            message: `Apple Notes account output is incompatible: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }

    return {
      healthy: checks.every((candidate) => candidate.status !== "fail"),
      checks,
    };
  }
}
