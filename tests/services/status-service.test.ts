import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CkbConfigSchema,
  StatusService,
  initializeWorkspace,
  loadState,
  saveState,
} from "../../src/index.js";

describe("status service", () => {
  it("reports local pipeline state without probing Apple Notes", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-status-"));
    await initializeWorkspace({ vault, dryRun: false });
    const config = CkbConfigSchema.parse({ schemaVersion: 1, vaultPath: vault });
    const state = await loadState(vault);
    state.pipeline = {
      lastSuccessfulRefreshAt: "2026-08-24T01:00:00.000Z",
      lastExtraction: {
        operationId: "op:00000000-0000-4000-8000-000000000001",
        completedAt: "2026-08-24T00:59:00.000Z",
        extractorName: "fixture",
        extractorVersion: "1.0.0",
        noteCount: 20,
        warningCount: 1,
        unsupportedAccounts: [],
      },
      lastCompilation: {
        operationId: "op:00000000-0000-4000-8000-000000000001",
        compilerName: "llm-wiki-compiler",
        compilerVersion: "1.1.0",
        compiled: 3,
        skipped: 17,
        deleted: 0,
        lintWarnings: 0,
      },
    };
    await saveState(vault, state);

    const result = await new StatusService({ env: { ANTHROPIC_API_KEY: "test" } }).read({
      vault,
      config,
    });

    expect(result).toMatchObject({
      workspace: { pages: 0, sources: 0, pendingReviews: 0, locked: false },
      extraction: { noteCount: 20, warningCount: 1 },
      compilation: { compiled: 3, skipped: 17 },
      dependencies: {
        appleNotesExporter: { probed: false },
        provider: { name: "anthropic", credentialsPresent: true },
      },
    });
  });

  it("reports a vault-configured Claude Agent provider", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-status-provider-"));
    await initializeWorkspace({ vault, dryRun: false });
    const config = CkbConfigSchema.parse({
      schemaVersion: 1,
      vaultPath: vault,
      compiler: { provider: "claude-agent" },
    });

    const result = await new StatusService({ env: {} }).read({ vault, config });
    expect(result.dependencies.provider).toEqual({
      name: "claude-agent",
      credentialsPresent: true,
    });
  });

  it("reports Codex primary and the manual fallback without probing either", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-status-codex-"));
    await initializeWorkspace({ vault, dryRun: false });
    const config = CkbConfigSchema.parse({
      schemaVersion: 1,
      vaultPath: vault,
      compiler: {
        primary: {
          adapter: "codex-agent",
          executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
        fallback: { adapter: "llmwiki", provider: "claude-agent" },
      },
    });
    const result = await new StatusService({ env: {} }).read({ vault, config });
    expect(result.dependencies.compiler).toMatchObject({
      adapter: "codex-agent",
      model: "gpt-5.6-sol",
      fallback: { adapter: "llmwiki", provider: "claude-agent" },
      fallbackPolicy: "manual",
    });
    expect(result.dependencies.provider).toEqual({
      name: "chatgpt-login",
      credentialsPresent: null,
    });
  });

  it("reports readable graph coverage, relationship origins, and live graph shape", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-status-graph-"));
    await initializeWorkspace({ vault, dryRun: false });
    const config = CkbConfigSchema.parse({ schemaVersion: 2, vaultPath: vault });
    const state = await loadState(vault);
    state.sources["a".repeat(64)] = {
      sourceId: `apple-note:${"a".repeat(64)}`,
      noteIdHash: "a".repeat(64),
      path: "Notes/Investments.md",
      title: "Investments",
      aliases: [],
      account: "iCloud",
      folder: "Notes",
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      attachmentHashes: [],
      censusStatus: "present",
      missingCensusCount: 0,
      primaryMoc: "investments",
      secondaryMocs: [],
      syncStatus: "clean",
    };
    state.relationships["rel:test"] = {
      relationshipId: "rel:test",
      fromId: `apple-note:${"a".repeat(64)}`,
      toId: `apple-note:${"b".repeat(64)}`,
      kind: "related",
      origin: "inferred",
      rejected: false,
    };
    state.unresolvedReferences["unresolved:test"] = {
      unresolvedId: "unresolved:test",
      sourceId: `apple-note:${"a".repeat(64)}`,
      status: "missing",
      label: "Unknown",
      candidates: [],
      origin: "double-arrow",
      reviewPath: "Reviews/Links/test.md",
    };
    state.sources["c".repeat(64)] = {
      ...state.sources["a".repeat(64)]!,
      sourceId: `apple-note:${"c".repeat(64)}`,
      noteIdHash: "c".repeat(64),
      path: "Notes/Protected Key.md",
      title: "Protected Key",
      censusStatus: "excluded",
      syncStatus: "clean",
      primaryMoc: undefined,
    };
    await saveState(vault, state);
    await writeFile(join(vault, "Home.md"), "# Home\n\n[[MOCs/Investments|Investments]]\n");
    await writeFile(join(vault, "MOCs/Investments.md"), "# Investments\n\n[[Notes/Investments|Investments]]\n");
    await writeFile(join(vault, "Notes/Investments.md"), "# Investments\n\n[[MOCs/Investments|Investments]]\n");
    await writeFile(join(vault, "Notes/Protected Key.md"), "# Protected Key\n");
    await mkdir(join(vault, "Reviews/Links"), { recursive: true });
    await writeFile(join(vault, "Reviews/Links/test.md"), "---\nstatus: pending\n---\n# Review\n");

    const result = await new StatusService().read({ vault, config });

    expect(result.graph).toMatchObject({
      readableSources: 2,
      protectedSources: 1,
      assignedSources: 1,
      unresolvedExplicitReferences: 1,
      syncStatuses: { clean: 2, localDivergence: 0, conflict: 0 },
      relationshipsByOrigin: { inferred: 1 },
      metrics: { nodes: 3, edges: 2, components: 1, isolates: [] },
    });
    expect(result.workspace.pendingReviews).toBe(1);
  });
});
