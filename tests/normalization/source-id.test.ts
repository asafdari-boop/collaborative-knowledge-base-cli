import { describe, expect, it } from "vitest";
import { allocateSourcePaths, sourceIdentity } from "../../src/normalization/source-id.js";

describe("stable source identity", () => {
  it("derives identity and path only from the stable note ID", () => {
    const first = sourceIdentity("x-coredata://stable-note");
    const afterTitleRename = sourceIdentity("x-coredata://stable-note");

    expect(first).toEqual(afterTitleRename);
    expect(first.sourceId).toMatch(/^apple-note:[0-9a-f]{64}$/);
    expect(first.path).toMatch(/^Sources\/Apple Notes\/apple-note-[0-9a-f]{16}\.md$/);
  });

  it("expands both filenames when shortened hashes collide", () => {
    const hashes = new Map([
      ["note-a", `${"a".repeat(16)}${"1".repeat(48)}`],
      ["note-b", `${"a".repeat(16)}${"2".repeat(48)}`],
    ]);
    const paths = allocateSourcePaths(["note-a", "note-b"], {
      hashNoteId: (id) => hashes.get(id) ?? "",
    });

    expect(paths.get("note-a")).toBe(
      `Sources/Apple Notes/apple-note-${"a".repeat(16)}${"1".repeat(48)}.md`,
    );
    expect(paths.get("note-b")).toBe(
      `Sources/Apple Notes/apple-note-${"a".repeat(16)}${"2".repeat(48)}.md`,
    );
  });

  it("rejects duplicate or invalid hash identities", () => {
    expect(() => allocateSourcePaths(["same", "same"])).toThrow();
    expect(() =>
      allocateSourcePaths(["note"], { hashNoteId: () => "not-a-hash" }),
    ).toThrow();
  });
});
