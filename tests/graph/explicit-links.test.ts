import { describe, expect, it } from "vitest";
import {
  buildSourceReferenceIndex,
  extractDoubleArrowReferences,
  resolveExplicitRelationships,
  resolveTitleReference,
  sourceIdentity,
} from "../../src/index.js";

function source(id: string, title: string, path: string, aliases: string[] = []) {
  const identity = sourceIdentity(id);
  return {
    sourceId: identity.sourceId,
    noteIdHash: identity.noteIdHash,
    title,
    path,
    aliases,
  };
}

describe("explicit Apple Notes graph relationships", () => {
  const books = source("note-books", "Reading List", "Notes/Reading List.md", ["Reading list (preferred)"]);
  const thinker = source("note-thinker", "Example Thinker", "Notes/Example Thinker.md");

  it("extracts plain, HTML-escaped, bulleted, and bold child references", () => {
    expect(extractDoubleArrowReferences([
      ">>Reading List",
      "&gt;&gt; Example Thinker",
      "- **>>Favorite Quotations**",
      "ordinary prose >> is not a relationship",
    ].join("\n"))).toEqual(["Reading List", "Example Thinker", "Favorite Quotations"]);
  });

  it("resolves unique titles and aliases with normalized formatting", () => {
    const index = buildSourceReferenceIndex([books, thinker]);
    expect(resolveTitleReference(" reading   list ", index)).toEqual({
      status: "resolved",
      sourceId: books.sourceId,
    });
    expect(resolveTitleReference("Reading list (preferred).", index)).toEqual({
      status: "resolved",
      sourceId: books.sourceId,
    });
  });

  it("resolves a unique descriptive suffix without guessing among multiple prefixes", () => {
    const competitors = source(
      "note-competitors",
      "ExampleCo Competitors encore",
      "Notes/ExampleCo Competitors encore.md",
    );
    const quotes = source("note-quotes", "Favorite Quotations", "Notes/Favorite Quotations.md");
    const index = buildSourceReferenceIndex([competitors, quotes]);

    expect(resolveTitleReference("ExampleCo Competitors", index)).toEqual({
      status: "resolved",
      sourceId: competitors.sourceId,
    });
    expect(resolveTitleReference("Favorite Quotations** - Viktor Frankl", index)).toEqual({
      status: "resolved",
      sourceId: quotes.sourceId,
    });

    const ambiguous = buildSourceReferenceIndex([
      competitors,
      source("note-competitors-2", "ExampleCo Competitors archive", "Notes/Archive.md"),
    ]);
    expect(resolveTitleReference("ExampleCo Competitors", ambiguous)).toMatchObject({
      status: "ambiguous",
    });
  });

  it("never guesses duplicate or missing titles", () => {
    const duplicate = source(
      "note-thinker-2",
      "example thinker",
      "Notes/example thinker — Archive.md",
    );
    const index = buildSourceReferenceIndex([books, thinker, duplicate]);
    expect(resolveTitleReference("Example Thinker", index)).toEqual({
      status: "ambiguous",
      candidates: [thinker.sourceId, duplicate.sourceId].sort(),
    });
    expect(resolveTitleReference("Unknown", index)).toEqual({ status: "missing" });
  });

  it("creates deterministic child and related edges while reporting unresolved references", () => {
    const parent = source(
      "note-parent",
      "Personal Knowledge Base",
      "Notes/Personal Knowledge Base.md",
    );
    const duplicate = source(
      "note-thinker-2",
      "example thinker",
      "Notes/example thinker — Archive.md",
    );
    const index = buildSourceReferenceIndex([parent, books, thinker, duplicate]);
    const result = resolveExplicitRelationships({
      source: parent,
      markdown: ">>Reading List\n>>Example Thinker\n>>Missing Note\n",
      internalLinks: [{
        href: "applenotes://note-books",
        label: "Books",
        targetNoteId: "note-books",
      }],
      index,
    });

    expect(result.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromId: parent.sourceId,
        toId: books.sourceId,
        kind: "child",
        origin: "explicit",
      }),
      expect.objectContaining({
        fromId: parent.sourceId,
        toId: books.sourceId,
        kind: "related",
        origin: "explicit",
      }),
    ]));
    expect(new Set(result.relationships.map((relationship) => relationship.relationshipId)).size)
      .toBe(result.relationships.length);
    expect(result.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "ambiguous", label: "Example Thinker" }),
      expect.objectContaining({ status: "missing", label: "Missing Note" }),
    ]));
  });

  it("deduplicates the same unresolved reference across arrows and native links", () => {
    const parent = source("note-parent", "Books", "Notes/Books.md");
    const result = resolveExplicitRelationships({
      source: parent,
      markdown: ">>Reading list\n",
      internalLinks: [{
        href: "applenotes:note/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        label: "Reading list",
        targetNoteId: "note-outside-scope",
      }],
      index: buildSourceReferenceIndex([parent]),
    });

    expect(result.unresolved).toEqual([expect.objectContaining({
      label: "Reading list",
      origin: "apple-link",
      status: "missing",
    })]);
  });
});
