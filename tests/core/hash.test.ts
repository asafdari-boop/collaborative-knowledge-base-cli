import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";

describe("sha256", () => {
  it("returns a stable lowercase digest", () => {
    expect(sha256("knowledge")).toBe(
      "e0f895872d65b2528feec97350a3a212b3d4ab88748e25d022a34641d338216b",
    );
  });
});
