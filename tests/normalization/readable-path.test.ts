import { describe, expect, it } from "vitest";
import {
  allocateReadableNotePaths,
  sanitizeReadableTitle,
  sourceIdentity,
} from "../../src/index.js";

function note(id: string, title: string, folderName = "Notes") {
  return { id, title, folderName };
}

describe("human-readable Apple Note paths", () => {
  it("uses a readable title for a unique note", () => {
    const allocation = allocateReadableNotePaths([note("note-a", "Investments")]);
    expect(allocation.paths.get("note-a")).toBe("Notes/Investments.md");
  });

  it("does not duplicate a Markdown extension that is part of the note title", () => {
    const allocation = allocateReadableNotePaths([
      note("note-a", "~/plans/example-plan.md"),
    ]);
    expect(allocation.paths.get("note-a")).toBe("Notes/~ - plans - example-plan.md");
  });

  it("repairs a previously generated duplicate Markdown extension", () => {
    const identity = sourceIdentity("note-a");
    const allocation = allocateReadableNotePaths(
      [note("note-a", "~/plans/example-plan.md")],
      {
        [identity.noteIdHash]: {
          path: "Notes/~ - plans - example-plan.md.md",
          title: "~/plans/example-plan.md",
          aliases: [],
        },
      },
    );
    expect(allocation.paths.get("note-a")).toBe("Notes/~ - plans - example-plan.md");
    expect(allocation.moves).toEqual([{
      sourceId: identity.sourceId,
      from: "Notes/~ - plans - example-plan.md.md",
      to: "Notes/~ - plans - example-plan.md",
    }]);
  });

  it("sanitizes filesystem characters and blank titles deterministically", () => {
    expect(sanitizeReadableTitle("  Health: Labs / 2026\u0000 ")).toBe("Health - Labs - 2026");
    expect(sanitizeReadableTitle(" ... ")).toBe("Untitled Note");
    expect(sanitizeReadableTitle("Ｃａｆｅ́")).toBe("Café");
  });

  it("uses folders and then stable suffixes for duplicate titles", () => {
    const allocation = allocateReadableNotePaths([
      note("note-a", "Example Thinker", "People"),
      note("note-b", "example thinker", "Archive"),
      note("note-c", "Example Thinker", "Archive"),
    ]);

    expect(allocation.paths.get("note-a")).toBe("Notes/Example Thinker — People.md");
    expect(allocation.paths.get("note-b")).toMatch(/^Notes\/example thinker — Archive — [0-9a-f]{8}\.md$/);
    expect(allocation.paths.get("note-c")).toMatch(/^Notes\/Example Thinker — Archive — [0-9a-f]{8}\.md$/);
    expect(new Set([...allocation.paths.values()].map((path) => path.toLocaleLowerCase())))
      .toHaveLength(3);
  });

  it("preserves a stable readable allocation until the title changes", () => {
    const noteIdHash = sourceIdentity("note-a").noteIdHash;
    const previous = {
      [noteIdHash]: {
        path: "Notes/Investments.md",
        title: "Investments",
        aliases: [],
      },
    };

    const unchanged = allocateReadableNotePaths([note("note-a", "Investments")], previous);
    expect(unchanged.paths.get("note-a")).toBe("Notes/Investments.md");
    expect(unchanged.moves).toEqual([]);

    const renamed = allocateReadableNotePaths([note("note-a", "Investment Framework")], previous);
    expect(renamed.paths.get("note-a")).toBe("Notes/Investment Framework.md");
    expect(renamed.aliases.get("note-a")).toEqual(["Investments"]);
    expect(renamed.moves).toEqual([{
      sourceId: sourceIdentity("note-a").sourceId,
      from: "Notes/Investments.md",
      to: "Notes/Investment Framework.md",
    }]);
  });

  it("does not silently migrate a legacy hash path during routine refresh", () => {
    const identity = sourceIdentity("note-a");
    const allocation = allocateReadableNotePaths([note("note-a", "Investments")], {
      [identity.noteIdHash]: {
        path: identity.path,
        title: "Investments",
        aliases: [],
      },
    });
    expect(allocation.paths.get("note-a")).toBe(identity.path);
    expect(allocation.moves).toEqual([]);
  });
});
