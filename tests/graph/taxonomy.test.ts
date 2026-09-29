import { describe, expect, it } from "vitest";
import { DEFAULT_TAXONOMY, renderTaxonomyMarkdown } from "../../src/index.js";

describe("approved knowledge taxonomy", () => {
  it("contains exactly the approved eight top-level domains", () => {
    expect(DEFAULT_TAXONOMY.domains.map((domain) => domain.slug)).toEqual([
      "thinking-and-frameworks",
      "goals-and-values",
      "health-and-fitness",
      "writing-and-learning",
      "business-and-money",
      "technology",
      "people-and-community",
      "taste",
    ]);
  });

  it("contains the approved MOCs under their intended domains", () => {
    expect(DEFAULT_TAXONOMY.mocs).toHaveLength(27);
    expect(DEFAULT_TAXONOMY.mocs.find((moc) => moc.slug === "investments"))
      .toMatchObject({ title: "Investments", domainSlug: "business-and-money" });
    expect(DEFAULT_TAXONOMY.mocs.find((moc) => moc.slug === "fitness-and-training"))
      .toMatchObject({ domainSlug: "health-and-fitness" });
    expect(DEFAULT_TAXONOMY.mocs.find((moc) => moc.slug === "best-of-lists"))
      .toMatchObject({ domainSlug: "taste" });
  });

  it("uses only generic aliases in the distributable default taxonomy", () => {
    const aliases = DEFAULT_TAXONOMY.mocs.flatMap((moc) => moc.aliases);
    expect(aliases).toEqual([
      "Decision equations",
      "Power principles",
      "Personal principles",
      "Agency",
      "Influential People",
      "Example Thinker",
      "Favorite Quotations",
      "Jokes and Memes",
    ]);
  });

  it("renders the human-editable taxonomy without machine-only IDs", () => {
    const markdown = renderTaxonomyMarkdown(DEFAULT_TAXONOMY);
    expect(markdown).toContain("# Knowledge Taxonomy");
    expect(markdown).toContain("## Business and Money");
    expect(markdown).toContain("- Investments");
    expect(markdown).not.toContain("apple-note-");
  });
});
