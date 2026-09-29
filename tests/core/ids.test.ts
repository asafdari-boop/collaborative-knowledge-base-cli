import { describe, expect, it } from "vitest";
import { newOperationId, newPageId, newReviewId } from "../../src/core/ids.js";

describe("IDs", () => {
  it("creates typed UUID-backed IDs", () => {
    expect(newPageId()).toMatch(/^page:[0-9a-f-]{36}$/);
    expect(newOperationId()).toMatch(/^op:[0-9a-f-]{36}$/);
    expect(newReviewId()).toMatch(/^review:[0-9a-f-]{36}$/);
  });

  it("does not reuse IDs", () => {
    expect(newPageId()).not.toBe(newPageId());
  });
});
