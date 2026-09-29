import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CkbConfigSchema,
  CollaborationService,
  createReview,
  DoctorService,
  initializeWorkspace,
} from "../../src/index.js";
import type { ProcessRunner } from "../../src/index.js";

async function setup(accountAllowlist: string[] = [], databasePath?: string) {
  const vault = await mkdtemp(join(tmpdir(), "ckb-doctor-"));
  await initializeWorkspace({ vault, dryRun: false });
  const config = CkbConfigSchema.parse({
    schemaVersion: 1,
    vaultPath: vault,
    extractor: { accountAllowlist, ...(databasePath ? { databasePath } : {}) },
  });
  return { vault, config };
}

function runnerFor(outputs: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>): ProcessRunner {
  return async (request) => {
    const key = request.args.join(" ");
    const output = outputs[key];
    if (!output) throw new Error(`missing fixture for ${key}`);
    return {
      stdout: output.stdout ?? "",
      stderr: output.stderr ?? "",
      exitCode: output.exitCode ?? 0,
      signal: null,
    };
  };
}

function check(result: Awaited<ReturnType<DoctorService["run"]>>, id: string) {
  return result.checks.find((candidate) => candidate.id === id);
}

describe("doctor service", () => {
  it("reports a missing exporter and missing provider credentials", async () => {
    const { vault, config } = await setup();
    const runner: ProcessRunner = async () => {
      throw new Error("ENOENT");
    };

    const result = await new DoctorService({ runner, env: {} }).run({ vault, config });

    expect(result.healthy).toBe(false);
    expect(check(result, "apple_notes_exporter")).toMatchObject({ status: "fail" });
    expect(check(result, "llm_provider_credentials")).toMatchObject({ status: "fail" });
  });

  it("routes every exporter probe through the configured copied database", async () => {
    const databasePath = "/backups/Apple Notes/NoteStore.sqlite";
    const { vault, config } = await setup(["iCloud"], databasePath);
    const result = await new DoctorService({
      runner: runnerFor({
        "--version": { stdout: "2.0.0\n" },
        [`list-accounts --db ${databasePath} --format json`]: {
          stdout: '{"accounts":[{"id":"a","name":"iCloud","type":"cloud"}],"count":1}\n',
        },
      }),
      env: { ANTHROPIC_API_KEY: "test-key" },
    }).run({ vault, config });

    expect(result.healthy).toBe(true);
    expect(check(result, "full_disk_access")).toMatchObject({ status: "pass" });
  });

  it("accepts the configured Claude Agent local-login provider without an API key", async () => {
    const { vault } = await setup();
    const config = CkbConfigSchema.parse({
      schemaVersion: 1,
      vaultPath: vault,
      compiler: { provider: "claude-agent" },
    });
    const result = await new DoctorService({
      runner: runnerFor({
        "--version": { stdout: "2.0.0\n" },
        "list-accounts --format json": { stdout: '{"accounts":[],"count":0}\n' },
      }),
      env: {},
    }).run({ vault, config });

    expect(check(result, "llm_provider_credentials")).toMatchObject({ status: "pass" });
  });

  it("checks the Codex executable and saved ChatGPT login while treating fallback as manual", async () => {
    const { vault } = await setup();
    const executable = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const config = CkbConfigSchema.parse({
      schemaVersion: 1,
      vaultPath: vault,
      compiler: {
        primary: {
          adapter: "codex-agent",
          executable,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
        fallback: { adapter: "llmwiki", provider: "claude-agent" },
      },
    });
    const runner: ProcessRunner = async (request) => {
      if (request.executable === executable && request.args.join(" ") === "--version") {
        return { stdout: "codex-cli 0.149.0\n", stderr: "", exitCode: 0, signal: null };
      }
      if (request.executable === executable && request.args.join(" ") === "login status") {
        return { stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0, signal: null };
      }
      if (request.args.join(" ") === "--version") {
        return { stdout: "2.0.0\n", stderr: "", exitCode: 0, signal: null };
      }
      throw new Error(`unexpected process ${request.executable} ${request.args.join(" ")}`);
    };

    const result = await new DoctorService({ runner, env: {} }).run({
      vault,
      config,
      probeNotes: false,
    });
    expect(check(result, "codex_primary")).toMatchObject({ status: "pass" });
    expect(check(result, "manual_fallback")).toMatchObject({ status: "pass" });
    expect(result.healthy).toBe(true);
  });

  it("uses the GitHub token required by llmwiki's Copilot provider", async () => {
    const { vault } = await setup();
    const config = CkbConfigSchema.parse({
      schemaVersion: 1,
      vaultPath: vault,
      compiler: { provider: "copilot" },
    });
    const result = await new DoctorService({
      runner: runnerFor({
        "--version": { stdout: "2.0.0\n" },
        "list-accounts --format json": { stdout: '{"accounts":[],"count":0}\n' },
      }),
      env: { GITHUB_TOKEN: "test-token" },
    }).run({ vault, config });

    expect(check(result, "llm_provider_credentials")).toMatchObject({ status: "pass" });
  });

  it("distinguishes incompatible output, Full Disk Access, and unsupported accounts", async () => {
    const { vault, config } = await setup(["iCloud", "Missing"]);
    const incompatible = await new DoctorService({
      runner: runnerFor({ "--version": { stdout: "1.9.0\n" } }),
      env: { ANTHROPIC_API_KEY: "test-key" },
    }).run({ vault, config });
    expect(check(incompatible, "apple_notes_exporter")).toMatchObject({ status: "fail" });

    const permission = await new DoctorService({
      runner: runnerFor({
        "--version": { stdout: "2.0.0\n" },
        "list-accounts --format json": {
          exitCode: 1,
          stderr: "Operation not permitted. Grant Full Disk Access.",
        },
      }),
      env: { ANTHROPIC_API_KEY: "test-key" },
    }).run({ vault, config });
    expect(check(permission, "full_disk_access")).toMatchObject({ status: "fail" });

    const unsupported = await new DoctorService({
      runner: runnerFor({
        "--version": { stdout: "2.0.0\n" },
        "list-accounts --format json": {
          stdout: '{"accounts":[{"id":"a","name":"iCloud","type":"cloud"}],"count":1}\n',
        },
      }),
      env: { ANTHROPIC_API_KEY: "test-key" },
    }).run({ vault, config });
    expect(check(unsupported, "configured_accounts")).toMatchObject({ status: "fail" });
  });

  it("reports corrupt state, pending recovery, and pending reviews", async () => {
    const { vault, config } = await setup();
    const pageId = "page:00000000-0000-4000-8000-000000000001";
    const base = `---\nckb_id: ${pageId}\n---\n# Page\n\nbase\n`;
    const live = base.replace("base", "human");
    const proposed = base.replace("base", "agent");
    await writeFile(join(vault, "Wiki/Page.md"), base);
    await new CollaborationService(vault).recordBase("Wiki/Page.md", base);
    await writeFile(join(vault, "Wiki/Page.md"), live);
    await createReview({
      vault,
      pageId,
      path: "Wiki/Page.md",
      base,
      live,
      proposed,
      reason: "merge_conflict",
    });
    await writeFile(join(vault, ".ckb/lock"), "stale lock\n");

    const result = await new DoctorService({
      runner: runnerFor({
        "--version": { stdout: "2.0.0\n" },
        "list-accounts --format json": { stdout: '{"accounts":[],"count":0}\n' },
      }),
      env: { ANTHROPIC_API_KEY: "test-key" },
    }).run({ vault, config });

    expect(check(result, "workspace_recovery")).toMatchObject({ status: "fail" });
    expect(check(result, "pending_reviews")).toMatchObject({ status: "warn" });

    await writeFile(join(vault, ".ckb/state.json"), "not json\n");
    const corrupt = await new DoctorService({
      runner: runnerFor({
        "--version": { stdout: "2.0.0\n" },
        "list-accounts --format json": { stdout: '{"accounts":[],"count":0}\n' },
      }),
      env: { ANTHROPIC_API_KEY: "test-key" },
    }).run({ vault, config });
    expect(check(corrupt, "workspace_state")).toMatchObject({ status: "fail" });
  });

  it("fails visibly when a prepared recovery record is unreadable", async () => {
    const { vault, config } = await setup();
    await mkdir(join(vault, ".ckb/recovery"), { recursive: true });
    await writeFile(
      join(vault, ".ckb/recovery/00000000-0000-4000-8000-000000000001.json"),
      "not json\n",
    );

    const result = await new DoctorService({
      runner: runnerFor({
        "--version": { stdout: "2.0.0\n" },
        "list-accounts --format json": { stdout: '{"accounts":[],"count":0}\n' },
      }),
      env: { ANTHROPIC_API_KEY: "test-key" },
    }).run({ vault, config });

    expect(check(result, "workspace_recovery")).toMatchObject({ status: "fail" });
    expect(check(result, "workspace_recovery")?.message).toContain("unreadable");
  });
});
