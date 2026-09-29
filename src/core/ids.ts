import { randomUUID } from "node:crypto";

export function newPageId(): string {
  return `page:${randomUUID()}`;
}

export function newOperationId(): string {
  return `op:${randomUUID()}`;
}

export function newReviewId(): string {
  return `review:${randomUUID()}`;
}
