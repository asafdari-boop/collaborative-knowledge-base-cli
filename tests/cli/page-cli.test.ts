import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CollaborationService,
  initializeWorkspace,
  loadState,
  saveState,
  sha256,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "dist/cli/main.js");

describe("page CLI", () => {
  it("creates a tracked source-backed synthesis without bypassing collaboration state", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-page-create-"));
    await initializeWorkspace({ vault, dryRun: false });
    const state = await loadState(vault);
    const hash = "a".repeat(64);
    state.sources[hash] = {
      sourceId: `apple-note:${hash}`,
      noteIdHash: hash,
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
      generatedHash: "b".repeat(64),
      syncStatus: "clean",
    };
    await saveState(vault, state);
    await mkdir(join(vault, "Notes"), { recursive: true });
    await writeFile(join(vault, "Notes/Investments.md"), "# Investments\n");
    await mkdir(join(vault, ".ckb/compiler/current"), { recursive: true });
    await writeFile(join(vault, ".ckb/compiler/current/manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      promptVersion: "2",
      taxonomyVersion: "1",
      compiler: { name: "codex-agent", version: "1.0.0", model: "gpt-5.6-sol" },
      sourceHashes: { "Investments.md": "b".repeat(64) },
      wikiHashes: {},
    }, null, 2)}\n`);
    const content = [
      "---",
      "ckb_id: page:investment-operating-system",
      "title: Investment Operating System",
      "summary: A durable framework for investing decisions.",
      "sources:",
      "  - Investments.md",
      "---",
      "# Investment Operating System",
      "",
      "Durable principles. [[Notes/Investments|Investments]]",
      "",
    ].join("\n");
    const contentFile = join(await mkdtemp(join(tmpdir(), "ckb-page-create-content-")), "page.md");
    await writeFile(contentFile, content);

    const created = await execFileAsync(process.execPath, [
      cliPath,
      "page",
      "create",
      "Wiki/Investment Operating System.md",
      "--vault",
      vault,
      "--content-file",
      contentFile,
      "--source",
      "Notes/Investments.md",
    ]);

    expect(JSON.parse(created.stdout)).toMatchObject({
      kind: "created",
      path: "Wiki/Investment Operating System.md",
    });
    expect(await readFile(join(vault, "Wiki/Investment Operating System.md"), "utf8")).toBe(content);
    const after = await loadState(vault);
    expect(after.pages["page:investment-operating-system"]).toMatchObject({
      path: "Wiki/Investment Operating System.md",
      sourceHashes: ["b".repeat(64)],
    });
    expect(after.wikiSynthesis["Wiki/Investment Operating System.md"]).toEqual({
      path: "Wiki/Investment Operating System.md",
      title: "Investment Operating System",
      summary: "A durable framework for investing decisions.",
      sourceIds: [`apple-note:${hash}`],
    });
    const manifest = JSON.parse(await readFile(join(vault, ".ckb/compiler/current/manifest.json"), "utf8"));
    expect(manifest.wikiHashes["Wiki/Investment Operating System.md"]).toBe(sha256(content));
  });

  it("lets an agent read and hash-check patch a tracked wiki page", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-page-cli-"));
    await initializeWorkspace({ vault, dryRun: false });
    const path = "Wiki/Page.md";
    const pageId = "page:00000000-0000-4000-8000-000000000001";
    const base = `---\nckb_id: ${pageId}\n---\n# Page\n\nOld\n`;
    await writeFile(join(vault, path), base);
    await new CollaborationService(vault).recordBase(path, base);

    const read = await execFileAsync(process.execPath, [
      cliPath,
      "page",
      "read",
      path,
      "--vault",
      vault,
    ]);
    expect(JSON.parse(read.stdout)).toEqual({
      path,
      pageId,
      hash: sha256(base),
      content: base,
    });

    const proposalPath = join(await mkdtemp(join(tmpdir(), "ckb-page-proposal-")), "page.md");
    const proposal = base.replace("Old", "Agent-safe edit");
    await writeFile(proposalPath, proposal);
    const patched = await execFileAsync(process.execPath, [
      cliPath,
      "page",
      "patch",
      path,
      "--vault",
      vault,
      "--expected-hash",
      sha256(base),
      "--content-file",
      proposalPath,
    ]);

    expect(JSON.parse(patched.stdout)).toMatchObject({ kind: "applied" });
    expect(await readFile(join(vault, path), "utf8")).toBe(proposal);
  });
});
