import { describe, expect, it } from "vitest";
import { packageReady } from "../src/index.js";

describe("package", () => {
  it("loads as an ESM TypeScript package", () => {
    expect(packageReady()).toBe(true);
  });
});
