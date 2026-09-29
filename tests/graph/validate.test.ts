import { describe, expect, it } from "vitest";
import { validateRenderedGraph } from "../../src/index.js";

describe("rendered graph validation", () => {
  it("accepts resolvable readable links and rejects unresolved or hash-named links", () => {
    const valid = [
      { path: "Home.md", content: "# Home\n\n[[Domains/Taste|Taste]]\n" },
      { path: "Domains/Taste.md", content: "# Taste\n" },
    ];
    expect(validateRenderedGraph(valid)).toMatchObject({ links: 1, unresolved: [] });
    expect(() => validateRenderedGraph([
      ...valid,
      { path: "Wiki/Bad.md", content: "[[Notes/Missing|Missing]]" },
    ])).toThrow(/unresolved/i);
    expect(() => validateRenderedGraph([
      { path: "Wiki/Bad.md", content: "[[Notes/apple-note-deadbeef|Bad]]" },
    ])).toThrow(/hash/i);
  });

  it("does not mistake a Markdown citation label for an Obsidian wikilink", () => {
    const pages = [{
      path: "Notes/Microplastics.md",
      content: "Wikipedia citation [[36]](https://example.com/reference).\n",
    }];

    expect(validateRenderedGraph(pages)).toMatchObject({ links: 0, unresolved: [] });
  });
});
