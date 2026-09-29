import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approveReview,
  CollaborationService,
  createReview,
  getObject,
  initializeWorkspace,
  listReviews,
  loadState,
  planReview,
  rejectReview,
  saveState,
} from "../../src/index.js";

const pageId = "page:00000000-0000-4000-8000-000000000001";
const base = `---\nckb_id: ${pageId}\n---\n# Page\n\nbase\n`;
const live = `---\nckb_id: ${pageId}\n---\n# Page\n\nhuman\n`;
const proposed = `---\nckb_id: ${pageId}\n---\n# Page\n\nagent\n`;

async function createPendingReview(vault: string) {
  await writeFile(join(vault, "Wiki/Page.md"), base);
  await new CollaborationService(vault).recordBase("Wiki/Page.md", base);
  await writeFile(join(vault, "Wiki/Page.md"), live);
  return createReview({
    vault,
    pageId,
    path: "Wiki/Page.md",
    base,
    live,
    proposed,
    reason: "merge_conflict",
  });
}

function archivePath(vault: string, reviewId: string): string {
  return join(vault, ".ckb/reviews/archive", `${reviewId.slice("review:".length)}.json`);
}

describe("review store", () => {
  it("plans a pending review without creating records or immutable objects", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-review-"));
    await initializeWorkspace({ vault, dryRun: false });
    await writeFile(join(vault, "Wiki/Page.md"), live);

    const plan = await planReview({
      vault,
      pageId,
      path: "Wiki/Page.md",
      base,
      live,
      proposed,
      reason: "merge_conflict",
    });

    expect(plan.record.status).toBe("pending");
    expect(await listReviews(vault)).toEqual([]);
    expect(await readdir(join(vault, ".ckb/objects"))).toEqual([]);
    await expect(access(join(vault, plan.record.visiblePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates machine and human records backed by immutable revisions", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-review-"));
    await initializeWorkspace({ vault, dryRun: false });

    const review = await createPendingReview(vault);

    expect(await listReviews(vault)).toEqual([review]);
    expect(await getObject(vault, review.baseObjectHash)).toBe(base);
    expect(await getObject(vault, review.liveObjectHash)).toBe(live);
    expect(await getObject(vault, review.proposedObjectHash)).toBe(proposed);
    const visible = await readFile(join(vault, review.visiblePath), "utf8");
    expect(visible).toContain("[[Wiki/Page]]");
    expect(visible).toContain(`ckb review approve ${review.reviewId}`);
    expect(visible).toContain(`ckb review reject ${review.reviewId}`);
  });

  it("approves a current review and archives its audit record", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-review-"));
    await initializeWorkspace({ vault, dryRun: false });
    const review = await createPendingReview(vault);

    await approveReview(vault, review.reviewId);

    expect(await readFile(join(vault, "Wiki/Page.md"), "utf8")).toBe(proposed);
    expect(await listReviews(vault)).toEqual([]);
    await expect(access(join(vault, review.visiblePath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(archivePath(vault, review.reviewId), "utf8"))).toMatchObject({
      reviewId: review.reviewId,
      status: "approved",
    });
  });

  it("does not change the page when review archival cannot be committed", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-review-"));
    await initializeWorkspace({ vault, dryRun: false });
    const review = await createPendingReview(vault);
    await writeFile(archivePath(vault, review.reviewId), "occupied\n");

    await expect(approveReview(vault, review.reviewId)).rejects.toMatchObject({
      code: "stale_review",
    });

    expect(await readFile(join(vault, "Wiki/Page.md"), "utf8")).toBe(live);
    expect(await listReviews(vault)).toHaveLength(1);
    expect(await readFile(join(vault, review.visiblePath), "utf8")).toContain("Pending");
  });

  it("refuses approval after the live page changes", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-review-"));
    await initializeWorkspace({ vault, dryRun: false });
    const review = await createPendingReview(vault);
    const newerHuman = live.replace("human", "newer human");
    await writeFile(join(vault, "Wiki/Page.md"), newerHuman);

    await expect(approveReview(vault, review.reviewId)).rejects.toMatchObject({
      code: "stale_review",
    });

    expect(await readFile(join(vault, "Wiki/Page.md"), "utf8")).toBe(newerHuman);
    expect(await listReviews(vault)).toHaveLength(1);
  });

  it("rejects a review without changing the live page", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-review-"));
    await initializeWorkspace({ vault, dryRun: false });
    const review = await createPendingReview(vault);

    await rejectReview(vault, review.reviewId);

    expect(await readFile(join(vault, "Wiki/Page.md"), "utf8")).toBe(live);
    expect(await listReviews(vault)).toEqual([]);
    expect(JSON.parse(await readFile(archivePath(vault, review.reviewId), "utf8"))).toMatchObject({
      reviewId: review.reviewId,
      status: "rejected",
    });
  });

  it("rejects a malicious page path before creating artifacts", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-review-"));
    await initializeWorkspace({ vault, dryRun: false });

    await expect(
      createReview({
        vault,
        pageId,
        path: "../outside.md",
        base: "base\n",
        live: "human\n",
        proposed: "agent\n",
        reason: "merge_conflict",
      }),
    ).rejects.toMatchObject({ code: "path_escape" });
    expect(await listReviews(vault)).toEqual([]);
  });

  it("refuses approval when the page is no longer tracked", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-review-"));
    await initializeWorkspace({ vault, dryRun: false });
    const review = await createPendingReview(vault);
    const state = await loadState(vault);
    delete state.pages[pageId];
    await saveState(vault, state);

    await expect(approveReview(vault, review.reviewId)).rejects.toMatchObject({
      code: "stale_review",
    });
    expect(await readFile(join(vault, "Wiki/Page.md"), "utf8")).toBe(live);
  });

  it("refuses approval when tracked state points to another path", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-review-"));
    await initializeWorkspace({ vault, dryRun: false });
    const review = await createPendingReview(vault);
    const state = await loadState(vault);
    state.pages[pageId]!.path = "Wiki/Moved.md";
    await saveState(vault, state);

    await expect(approveReview(vault, review.reviewId)).rejects.toMatchObject({
      code: "stale_review",
    });
    expect(await readFile(join(vault, "Wiki/Page.md"), "utf8")).toBe(live);
  });

  it("rejects review content that changes the stable page ID", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-review-"));
    await initializeWorkspace({ vault, dryRun: false });
    await writeFile(join(vault, "Wiki/Page.md"), live);

    await expect(
      createReview({
        vault,
        pageId,
        path: "Wiki/Page.md",
        base,
        live,
        proposed: proposed.replace(pageId, "page:00000000-0000-4000-8000-000000000002"),
        reason: "merge_conflict",
      }),
    ).rejects.toMatchObject({ code: "page_identity_mismatch" });
    expect(await listReviews(vault)).toEqual([]);
  });
});
