import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAXONOMY,
  renderKnowledgeGraph,
  sourceIdentity,
} from "../../src/index.js";

function source(index: number) {
  const identity = sourceIdentity(`note-${index}`);
  return {
    sourceId: identity.sourceId,
    noteIdHash: identity.noteIdHash,
    path: `Notes/Investment Note ${String(index).padStart(2, "0")}.md`,
    title: `Investment Note ${String(index).padStart(2, "0")}`,
    aliases: [],
    account: "iCloud",
    folder: "Investing",
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    attachmentHashes: [],
    censusStatus: "present" as const,
    missingCensusCount: 0,
  };
}

describe("deterministic Obsidian graph rendering", () => {
  it("renders Home with exactly the eight approved domain links", () => {
    const rendered = renderKnowledgeGraph({
      taxonomy: DEFAULT_TAXONOMY,
      sources: [],
      assignments: [],
      relationships: [],
      wikiPages: [],
      mocDirectChildLimit: 50,
    });
    const home = rendered.pages.find((page) => page.path === "Home.md")!;
    expect(home.content).toContain("title: Personal Knowledge Base");
    expect(home.content).toContain("# Personal Knowledge Base");
    expect(home.content.match(/\[\[Domains\//g)).toHaveLength(8);
    expect(home.content).toContain("[[Domains/Business and Money|Business and Money]]");
    expect(home.content).not.toContain("Notes/");
  });

  it("makes useful syntheses and the all-notes view discoverable from Home", () => {
    const rendered = renderKnowledgeGraph({
      taxonomy: DEFAULT_TAXONOMY,
      sources: [],
      assignments: [],
      relationships: [],
      wikiPages: [{
        path: "Wiki/Decision System.md",
        title: "Decision System",
        summary: "A reusable way to compare consequential choices.",
        sourceIds: [],
      }],
      mocDirectChildLimit: 50,
    });
    const home = rendered.pages.find((page) => page.path === "Home.md")!;
    expect(home.content).toContain("## Syntheses");
    expect(home.content).toContain(
      "[[Wiki/Decision System|Decision System]] — A reusable way to compare consequential choices.",
    );
    expect(home.content).toContain("[Browse all notes](Views/All%20Notes.base)");
  });

  it("splits oversized MOCs and connects every source to a bounded parent", () => {
    const sources = Array.from({ length: 55 }, (_, index) => source(index));
    const rendered = renderKnowledgeGraph({
      taxonomy: DEFAULT_TAXONOMY,
      sources,
      assignments: sources.map((entry) => ({
        sourceId: entry.sourceId,
        primaryMoc: "investments",
        secondaryMocs: [],
      })),
      relationships: [],
      wikiPages: [],
      mocDirectChildLimit: 50,
    });
    const root = rendered.pages.find((page) => page.path === "MOCs/Investments.md")!;
    expect(root.content).toContain("[[MOCs/Investments — Collection 1|Investments — Collection 1]]");
    expect(root.content).toContain("[[MOCs/Investments — Collection 2|Investments — Collection 2]]");
    const collections = rendered.pages.filter((page) => page.path.startsWith("MOCs/Investments — Collection"));
    expect(collections).toHaveLength(2);
    expect(Math.max(...collections.map((page) => (page.content.match(/\[\[Notes\//g) ?? []).length)))
      .toBeLessThanOrEqual(50);
    expect(rendered.sourceConnections).toHaveLength(55);
    expect(rendered.sourceConnections[0]!.content).toContain("Parent: [[MOCs/Investments — Collection 1");
  });

  it("renders explicit and inferred related links with readable labels", () => {
    const sources = [source(1), source(2)];
    const rendered = renderKnowledgeGraph({
      taxonomy: DEFAULT_TAXONOMY,
      sources,
      assignments: sources.map((entry) => ({ sourceId: entry.sourceId, primaryMoc: "investments", secondaryMocs: [] })),
      relationships: [{
        relationshipId: "rel:one",
        fromId: sources[0]!.sourceId,
        toId: sources[1]!.sourceId,
        kind: "related",
        origin: "inferred",
        rationale: "Both notes test the same durability thesis.",
        confidence: 0.9,
        rejected: false,
      }],
      wikiPages: [],
      mocDirectChildLimit: 50,
    });
    expect(rendered.sourceConnections[0]!.content)
      .toContain("Related: [[Notes/Investment Note 02|Investment Note 02]]");
  });
});
