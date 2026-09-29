import { describe, expect, it } from "vitest";
import { mergeMarkdown } from "../../src/index.js";

describe("mergeMarkdown", () => {
  it("merges changes to separate sections", () => {
    const base = "# Page\n\n## Human\nOld\n\n## Agent\nOld\n";
    const human = "# Page\n\n## Human\nNew human\n\n## Agent\nOld\n";
    const proposed = "# Page\n\n## Human\nOld\n\n## Agent\nNew agent\n";

    expect(mergeMarkdown(base, human, proposed)).toEqual({
      kind: "merged",
      content: "# Page\n\n## Human\nNew human\n\n## Agent\nNew agent\n",
    });
  });

  it("returns structured conflicts without inserting conflict markers", () => {
    const result = mergeMarkdown("# Page\nOld\n", "# Page\nHuman\n", "# Page\nAgent\n");

    expect(result.kind).toBe("conflict");
    expect(JSON.stringify(result)).not.toContain("<<<<<<<");
  });

  it("accepts the same change made on both sides", () => {
    expect(mergeMarkdown("Old\n", "Same\n", "Same\n")).toEqual({
      kind: "merged",
      content: "Same\n",
    });
  });

  it("preserves a final-newline removal merged with another line edit", () => {
    expect(mergeMarkdown("A\nB\n", "Changed A\nB\n", "A\nB")).toEqual({
      kind: "merged",
      content: "Changed A\nB",
    });
  });

  it("merges empty documents without inventing a newline", () => {
    expect(mergeMarkdown("", "", "")).toEqual({ kind: "merged", content: "" });
  });
});
