import { mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CollaborationService,
  approveReview,
  initializeWorkspace,
  listReviews,
  loadState,
  sha256,
} from "../../src/index.js";

const pageId = "page:00000000-0000-4000-8000-000000000001";

describe("human-agent collaboration", () => {
  it("adopts an untracked human page before allowing compiler edits", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-flow-"));
    await initializeWorkspace({ vault, dryRun: false });
    const path = "Wiki/Manual.md";
    const manual = "# Manual\n\nHuman page.\n";
    const proposed = `---\nckb_id: ${pageId}\n---\n# Manual\n\nCompiler rewrite.\n`;
    await writeFile(join(vault, path), manual);

    const result = await new CollaborationService(vault).publishProposals([{ path, content: proposed }]);

    expect(result.adopted).toEqual([path]);
    expect(result.applied).toEqual([]);
    const adopted = await readFile(join(vault, path), "utf8");
    expect(adopted).toContain(`ckb_id: ${pageId}`);
    expect(adopted).toContain("Human page.");
    expect(adopted).not.toContain("Compiler rewrite.");
    expect((await loadState(vault)).pages[pageId]).toMatchObject({
      path,
      baseHash: sha256(adopted),
    });
  });

  it("publishes a new compiler page and begins tracking its stable identity", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-flow-"));
    await initializeWorkspace({ vault, dryRun: false });
    const path = "Wiki/concepts/New.md";
    const content = `---\nckb_id: ${pageId}\n---\n# New\n`;

    const result = await new CollaborationService(vault).publishProposals([{ path, content }]);

    expect(result.applied).toEqual([path]);
    expect(await readFile(join(vault, path), "utf8")).toBe(content);
    expect((await loadState(vault)).pages[pageId]).toMatchObject({
      path,
      baseHash: sha256(content),
      baseObjectHash: sha256(content),
    });
  });

  it("preserves page identity when a human moves a tracked page in Obsidian", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-flow-"));
    await initializeWorkspace({ vault, dryRun: false });
    const originalPath = "Wiki/Original.md";
    const movedPath = "Wiki/Moved.md";
    const base = `---\nckb_id: ${pageId}\n---\n# Page\n\nOld\n`;
    await writeFile(join(vault, originalPath), base);
    const service = new CollaborationService(vault);
    await service.recordBase(originalPath, base);
    await rename(join(vault, originalPath), join(vault, movedPath));

    const result = await service.publishProposals([
      { path: movedPath, content: base.replace("Old", "New") },
    ]);

    expect(result.moved).toEqual([movedPath]);
    expect(await readFile(join(vault, movedPath), "utf8")).toContain("New");
    expect((await loadState(vault)).pages[pageId]).toMatchObject({
      path: movedPath,
      aliases: [originalPath],
    });
  });

  it("does not mistake a copied page for a move while the original still exists", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-flow-"));
    await initializeWorkspace({ vault, dryRun: false });
    const originalPath = "Wiki/Original.md";
    const copiedPath = "Wiki/Copy.md";
    const base = `---\nckb_id: ${pageId}\n---\n# Page\n\nOld\n`;
    await writeFile(join(vault, originalPath), base);
    await writeFile(join(vault, copiedPath), base);
    const service = new CollaborationService(vault);
    await service.recordBase(originalPath, base);

    await expect(
      service.publishProposals([{ path: copiedPath, content: base.replace("Old", "New") }]),
    ).rejects.toMatchObject({ code: "page_identity_mismatch" });

    expect(await readFile(join(vault, originalPath), "utf8")).toBe(base);
    expect(await readFile(join(vault, copiedPath), "utf8")).toBe(base);
    expect((await loadState(vault)).pages[pageId]?.path).toBe(originalPath);
  });

  it("plans a conflict without writing the page, state, review, or objects", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-flow-"));
    await initializeWorkspace({ vault, dryRun: false });
    const path = "Wiki/Page.md";
    const base = `---\nckb_id: ${pageId}\n---\n# Page\n\nOld\n`;
    await writeFile(join(vault, path), base);
    const service = new CollaborationService(vault);
    await service.recordBase(path, base);
    await writeFile(join(vault, path), base.replace("Old", "Human"));
    const stateBefore = await readFile(join(vault, ".ckb/state.json"), "utf8");
    const objectsBefore = await readdir(join(vault, ".ckb/objects"));

    const plan = await service.planProposals([
      { path, content: base.replace("Old", "Agent"), expectedHash: sha256(base) },
    ]);

    expect(plan.result.reviews).toHaveLength(1);
    expect(await readFile(join(vault, path), "utf8")).toContain("Human");
    expect(await readFile(join(vault, ".ckb/state.json"), "utf8")).toBe(stateBefore);
    expect(await readdir(join(vault, ".ckb/objects"))).toEqual(objectsBefore);
    expect(await listReviews(vault)).toEqual([]);
  });

  it("merges separate edits and reviews overlapping edits without overwriting humans", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-flow-"));
    await initializeWorkspace({ vault, dryRun: false });
    const pagePath = join(vault, "Wiki/Frameworks.md");
    const base = `---\nckb_id: ${pageId}\n---\n# Frameworks\n\n## Human\nOld\n\n## Agent\nOld\n`;
    await writeFile(pagePath, base);
    const service = new CollaborationService(vault);
    await service.recordBase("Wiki/Frameworks.md", base, [sha256("synthetic source\n")]);

    await writeFile(pagePath, base.replace("## Human\nOld", "## Human\nMy note"));
    const first = await service.publishProposals([
      {
        path: "Wiki/Frameworks.md",
        content: base.replace("## Agent\nOld", "## Agent\nCompiled insight"),
        expectedHash: sha256(base),
      },
    ]);

    expect(first.applied).toEqual(["Wiki/Frameworks.md"]);
    expect(first.merged).toEqual(["Wiki/Frameworks.md"]);
    expect(first.reviews).toEqual([]);
    const shared = await readFile(pagePath, "utf8");
    expect(shared).toContain("My note");
    expect(shared).toContain("Compiled insight");

    await writeFile(pagePath, shared.replace("My note", "Human collision"));
    const second = await service.publishProposals([
      {
        path: "Wiki/Frameworks.md",
        content: shared.replace("My note", "Agent collision"),
        expectedHash: sha256(shared),
      },
    ]);

    expect(second.applied).toEqual([]);
    expect(second.reviews).toHaveLength(1);
    expect(await readFile(pagePath, "utf8")).toContain("Human collision");
    expect(await readFile(pagePath, "utf8")).not.toContain("Agent collision");
    expect(await listReviews(vault)).toHaveLength(1);
    const state = await loadState(vault);
    expect(state.pages[pageId]).toMatchObject({
      path: "Wiki/Frameworks.md",
      baseHash: sha256(shared),
      sourceHashes: [sha256("synthetic source\n")],
    });

    const pending = second.reviews[0];
    expect(pending).toBeDefined();
    await approveReview(vault, pending!.reviewId);
    const approved = await readFile(pagePath, "utf8");
    expect(approved).toContain("Agent collision");
    expect((await loadState(vault)).pages[pageId]).toMatchObject({
      baseHash: sha256(approved),
      baseObjectHash: pending!.proposedObjectHash,
      lastOperationId: expect.stringMatching(/^op:/),
    });
  });

  it("applies a direct patch only at the expected live hash", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-flow-"));
    await initializeWorkspace({ vault, dryRun: false });
    const path = "Wiki/Direct.md";
    const base = `---\nckb_id: ${pageId}\n---\n# Direct\n\nOld\n`;
    await writeFile(join(vault, path), base);
    const service = new CollaborationService(vault);
    await service.recordBase(path, base);

    await service.patchPage({
      path,
      expectedHash: sha256(base),
      content: base.replace("Old", "New"),
      actor: "test-agent",
    });
    await expect(
      service.patchPage({
        path,
        expectedHash: sha256(base),
        content: base.replace("Old", "Stale overwrite"),
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });

    expect(await readFile(join(vault, path), "utf8")).toContain("New");
    expect(await readFile(join(vault, path), "utf8")).not.toContain("Stale overwrite");
  });
});
