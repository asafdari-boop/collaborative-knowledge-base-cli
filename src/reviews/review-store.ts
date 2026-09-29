import {
  readFile,
  readdir,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import {
  PageIdentityMismatchError,
  ReviewNotFoundError,
  StaleReviewError,
} from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { newOperationId, newReviewId } from "../core/ids.js";
import { assertNoSymlinkAncestors, resolveInside } from "../core/paths.js";
import { parsePage } from "../pages/frontmatter.js";
import { getObject } from "../state/object-store.js";
import { applyTransaction, type TransactionChange } from "../publishing/transaction.js";
import { loadStateSnapshot } from "../state/state-store.js";

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const ReviewRecordSchema = z.object({
  schemaVersion: z.literal(1),
  reviewId: z.string().startsWith("review:"),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
  status: z.enum(["pending", "approved", "rejected"]),
  pageId: z.string().startsWith("page:"),
  path: z.string().min(1),
  visiblePath: z.string().min(1),
  reason: z.string().min(1),
  liveHash: HashSchema,
  baseObjectHash: HashSchema,
  liveObjectHash: HashSchema,
  proposedObjectHash: HashSchema,
});

export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export interface CreateReviewInput {
  vault: string;
  pageId: string;
  path: string;
  base: string;
  live: string;
  proposed: string;
  reason: string;
}

export interface ReviewPlan {
  record: ReviewRecord;
  liveAssertion: TransactionChange;
  visibleChange: TransactionChange;
  internalChange: TransactionChange;
  objects: string[];
}

function reviewSlug(reviewId: string): string {
  if (!/^review:[0-9a-f-]{36}$/.test(reviewId)) throw new ReviewNotFoundError(reviewId);
  return reviewId.slice("review:".length);
}

function pendingPath(vault: string, reviewId: string): string {
  return join(vault, ".ckb/reviews", `${reviewSlug(reviewId)}.json`);
}

function archivedPath(vault: string, reviewId: string): string {
  return join(vault, ".ckb/reviews/archive", `${reviewSlug(reviewId)}.json`);
}

function pageLink(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function reviewMarkdown(record: ReviewRecord, base: string, live: string, proposed: string): string {
  const baseToLive = createTwoFilesPatch("base", "live", base, live, "base", "human live");
  const liveToProposed = createTwoFilesPatch(
    "live",
    "proposed",
    live,
    proposed,
    "human live",
    "agent proposal",
  );
  return `---
ckb_review_id: ${record.reviewId}
status: pending
---
# Pending knowledge review

- Page: [[${pageLink(record.path)}]]
- Reason: ${record.reason}
- Live hash: \`${record.liveHash}\`
- [Base revision](../.ckb/objects/${record.baseObjectHash})
- [Live revision](../.ckb/objects/${record.liveObjectHash})
- [Proposed revision](../.ckb/objects/${record.proposedObjectHash})

## Base to human live

\`\`\`diff
${baseToLive.trimEnd()}
\`\`\`

## Human live to proposed

\`\`\`diff
${liveToProposed.trimEnd()}
\`\`\`

## Resolve

\`ckb review approve ${record.reviewId}\`

\`ckb review reject ${record.reviewId}\`
`;
}

async function readRecord(path: string, reviewId: string): Promise<ReviewRecord> {
  try {
    return ReviewRecordSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ReviewNotFoundError(reviewId);
    }
    throw error;
  }
}

export async function getReview(vault: string, reviewId: string): Promise<ReviewRecord> {
  return readRecord(pendingPath(vault, reviewId), reviewId);
}

export async function listReviews(vault: string): Promise<ReviewRecord[]> {
  const directory = join(vault, ".ckb/reviews");
  const names = await readdir(directory);
  const reviews = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => readRecord(join(directory, name), `review:${basename(name, ".json")}`)),
  );
  return reviews.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function createReview(input: CreateReviewInput): Promise<ReviewRecord> {
  const plan = await planReview(input);
  await applyTransaction({
    vault: input.vault,
    actor: "review:create",
    changes: [plan.liveAssertion, plan.visibleChange],
    internalChanges: [plan.internalChange],
    objects: plan.objects,
  });
  return plan.record;
}

export async function planReview(input: CreateReviewInput): Promise<ReviewPlan> {
  const pagePath = resolveInside(input.vault, input.path);
  await assertNoSymlinkAncestors(input.vault, pagePath);
  const actualLive = await readFile(pagePath, "utf8");
  if (actualLive !== input.live) throw new StaleReviewError("new review");
  const identities = [input.base, input.live, input.proposed].map(
    (content) => parsePage(content).id,
  );
  if (identities.some((identity) => identity !== input.pageId)) {
    throw new PageIdentityMismatchError(input.path);
  }

  const reviewId = newReviewId();
  const record = ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId,
    createdAt: new Date().toISOString(),
    status: "pending",
    pageId: input.pageId,
    path: input.path,
    visiblePath: `Reviews/${reviewSlug(reviewId)}.md`,
    reason: input.reason,
    liveHash: sha256(input.live),
    baseObjectHash: sha256(input.base),
    liveObjectHash: sha256(input.live),
    proposedObjectHash: sha256(input.proposed),
  });

  return {
    record,
    liveAssertion: {
      path: input.path,
      expectedHash: record.liveHash,
      content: input.live,
    },
    visibleChange: {
      path: record.visiblePath,
      expectedHash: null,
      content: reviewMarkdown(record, input.base, input.live, input.proposed),
    },
    internalChange: {
      path: `.ckb/reviews/${reviewSlug(reviewId)}.json`,
      expectedHash: null,
      content: `${JSON.stringify(record, null, 2)}\n`,
    },
    objects: [input.base, input.live, input.proposed],
  };
}

function archivedReview(
  record: ReviewRecord,
  status: "approved" | "rejected",
): ReviewRecord {
  return ReviewRecordSchema.parse({
    ...record,
    status,
    resolvedAt: new Date().toISOString(),
  });
}

function staleReviewFrom(error: unknown, reviewId: string): never {
  const code = (error as { code?: unknown }).code;
  if (code === "stale_revision" || code === "stale_state") {
    throw new StaleReviewError(reviewId);
  }
  throw error;
}

export async function approveReview(vault: string, reviewId: string): Promise<void> {
  const record = await getReview(vault, reviewId);
  const pending = await readFile(pendingPath(vault, reviewId), "utf8");
  const proposed = await getObject(vault, record.proposedObjectHash);
  const visible = await readFile(resolveInside(vault, record.visiblePath), "utf8");
  const stateSnapshot = await loadStateSnapshot(vault);
  const tracked = stateSnapshot.state.pages[record.pageId];
  if (!tracked || tracked.path !== record.path) throw new StaleReviewError(reviewId);
  const operationId = newOperationId();
  const archived = archivedReview(record, "approved");
  const slug = reviewSlug(reviewId);
  const nextState = {
    ...stateSnapshot.state,
    pages: {
      ...stateSnapshot.state.pages,
      [record.pageId]: {
        ...tracked,
        baseHash: sha256(proposed),
        baseObjectHash: record.proposedObjectHash,
        lastOperationId: operationId,
      },
    },
  };
  try {
    await applyTransaction({
      vault,
      actor: "review:approve",
      operationId,
      changes: [
        { path: record.path, expectedHash: record.liveHash, content: proposed },
        {
          path: record.visiblePath,
          expectedHash: sha256(visible),
          content: null,
        },
      ],
      internalChanges: [
        {
          path: `.ckb/reviews/${slug}.json`,
          expectedHash: sha256(pending),
          content: null,
        },
        {
          path: `.ckb/reviews/archive/${slug}.json`,
          expectedHash: null,
          content: `${JSON.stringify(archived, null, 2)}\n`,
        },
      ],
      nextState,
      expectedStateHash: stateSnapshot.hash,
    });
  } catch (error: unknown) {
    staleReviewFrom(error, reviewId);
  }
}

export async function rejectReview(vault: string, reviewId: string): Promise<void> {
  const record = await getReview(vault, reviewId);
  const pending = await readFile(pendingPath(vault, reviewId), "utf8");
  const visible = await readFile(resolveInside(vault, record.visiblePath), "utf8");
  const archived = archivedReview(record, "rejected");
  const slug = reviewSlug(reviewId);
  try {
    await applyTransaction({
      vault,
      actor: "review:reject",
      changes: [
        {
          path: record.visiblePath,
          expectedHash: sha256(visible),
          content: null,
        },
      ],
      internalChanges: [
        {
          path: `.ckb/reviews/${slug}.json`,
          expectedHash: sha256(pending),
          content: null,
        },
        {
          path: `.ckb/reviews/archive/${slug}.json`,
          expectedHash: null,
          content: `${JSON.stringify(archived, null, 2)}\n`,
        },
      ],
    });
  } catch (error: unknown) {
    staleReviewFrom(error, reviewId);
  }
}
