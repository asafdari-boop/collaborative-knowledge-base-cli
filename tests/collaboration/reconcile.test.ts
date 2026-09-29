import { describe, expect, it } from "vitest";
import { reconcilePage, sha256 } from "../../src/index.js";

describe("reconcilePage", () => {
  it("cleanly applies when the live page still equals the proposal base", () => {
    const base = "# Page\nBase\n";

    expect(
      reconcilePage({
        base,
        live: base,
        proposed: "# Page\nNew\n",
        expectedHash: sha256(base),
      }),
    ).toEqual({ kind: "apply", content: "# Page\nNew\n", mode: "clean" });
  });

  it("rejects a direct patch after the live page changes", () => {
    const base = "A\n";

    expect(
      reconcilePage({
        base,
        live: "Human\n",
        proposed: "Agent\n",
        expectedHash: sha256(base),
        directPatch: true,
      }),
    ).toMatchObject({ kind: "stale_revision", actualHash: sha256("Human\n") });
  });

  it("applies a direct patch when its expected hash matches the live page", () => {
    const live = "Current\n";

    expect(
      reconcilePage({
        base: "Earlier base\n",
        live,
        proposed: "Patched\n",
        expectedHash: sha256(live),
        directPatch: true,
      }),
    ).toEqual({ kind: "apply", content: "Patched\n", mode: "clean" });
  });

  it("three-way merges a compiler proposal with a non-overlapping human edit", () => {
    const base = "Human: old\nAgent: old\n";

    expect(
      reconcilePage({
        base,
        live: "Human: new\nAgent: old\n",
        proposed: "Human: old\nAgent: new\n",
        expectedHash: sha256(base),
      }),
    ).toEqual({
      kind: "apply",
      mode: "merged",
      content: "Human: new\nAgent: new\n",
    });
  });

  it("holds overlapping compiler edits as a conflict", () => {
    const base = "Value: old\n";

    expect(
      reconcilePage({
        base,
        live: "Value: human\n",
        proposed: "Value: agent\n",
        expectedHash: sha256(base),
      }).kind,
    ).toBe("conflict");
  });

  it("returns a no-op when live and proposed content already match", () => {
    const live = "Already shared\n";
    expect(
      reconcilePage({
        base: "Earlier\n",
        live,
        proposed: live,
        expectedHash: sha256("Earlier\n"),
      }),
    ).toEqual({ kind: "noop" });
  });

  it("rejects a proposal whose expected hash is not its supplied base", () => {
    expect(
      reconcilePage({
        base: "Base\n",
        live: "Base\n",
        proposed: "New\n",
        expectedHash: sha256("Different base\n"),
      }).kind,
    ).toBe("stale_revision");
  });
});
