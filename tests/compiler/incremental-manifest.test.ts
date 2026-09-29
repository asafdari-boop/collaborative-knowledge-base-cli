import { describe, expect, it } from "vitest";
import {
  calculateIncrementalManifest,
  type SuccessfulCompilerManifest,
} from "../../src/compiler/incremental-manifest.js";

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);

function previous(overrides: Partial<SuccessfulCompilerManifest> = {}): SuccessfulCompilerManifest {
  return {
    schemaVersion: 1,
    promptVersion: "2",
    taxonomyVersion: "1",
    compiler: { name: "codex-agent", version: "test", model: "model" },
    sourceHashes: { "one.md": a, "two.md": b },
    wikiHashes: { "Wiki/Home.md": c },
    ...overrides,
  };
}

describe("incremental compiler manifest", () => {
  it("requires a full formation when successful state is missing", () => {
    const result = calculateIncrementalManifest({
      sourceHashes: { "one.md": a },
      wikiHashes: {},
      pageSources: {},
      pageLinks: {},
      previous: null,
      rebuild: false,
    });
    expect(result).toMatchObject({ rebuild: true, rebuildReason: "missing_state", noOp: false });
    expect(result.newSources).toEqual(["one.md"]);
  });

  it("finds changed and missing sources plus directly affected pages", () => {
    const result = calculateIncrementalManifest({
      sourceHashes: { "one.md": b, "three.md": c },
      wikiHashes: { "Wiki/Home.md": c, "Wiki/MOCs/Ideas.md": a },
      pageSources: {
        "Wiki/Home.md": ["one.md"],
        "Wiki/MOCs/Ideas.md": ["two.md"],
      },
      pageLinks: { "Wiki/Home.md": ["Wiki/MOCs/Ideas.md"] },
      previous: previous(),
      rebuild: false,
    });
    expect(result.changedSources).toEqual(["one.md"]);
    expect(result.newSources).toEqual(["three.md"]);
    expect(result.missingSources).toEqual(["two.md"]);
    expect(result.affectedPages).toEqual(["Wiki/Home.md", "Wiki/MOCs/Ideas.md"]);
    expect(result.noOp).toBe(false);
  });

  it("skips the model only for identical source and editable-Wiki hashes", () => {
    const result = calculateIncrementalManifest({
      sourceHashes: { "one.md": a, "two.md": b },
      wikiHashes: { "Wiki/Home.md": c },
      pageSources: { "Wiki/Home.md": ["one.md"] },
      pageLinks: {},
      previous: previous(),
      rebuild: false,
    });
    expect(result).toMatchObject({ rebuild: false, rebuildReason: null, noOp: true });
  });

  it("treats a newly created or removed human Wiki page as affected", () => {
    const added = calculateIncrementalManifest({
      sourceHashes: { "one.md": a, "two.md": b },
      wikiHashes: { "Wiki/Home.md": c, "Wiki/New.md": a },
      pageSources: {},
      pageLinks: {},
      previous: previous(),
      rebuild: false,
    });
    expect(added.humanEditedPages).toEqual(["Wiki/New.md"]);
    const removed = calculateIncrementalManifest({
      sourceHashes: { "one.md": a, "two.md": b },
      wikiHashes: {},
      pageSources: {},
      pageLinks: {},
      previous: previous(),
      rebuild: false,
    });
    expect(removed.humanEditedPages).toEqual(["Wiki/Home.md"]);
  });

  it("forces rebuild for an explicit request or incompatible taxonomy", () => {
    const input = {
      sourceHashes: { "one.md": a, "two.md": b },
      wikiHashes: { "Wiki/Home.md": c },
      pageSources: {},
      pageLinks: {},
      previous: previous(),
    };
    expect(calculateIncrementalManifest({ ...input, rebuild: true }).rebuildReason)
      .toBe("explicit");
    expect(calculateIncrementalManifest({
      ...input,
      rebuild: false,
      previous: previous({ taxonomyVersion: "old" }),
    }).rebuildReason).toBe("incompatible_state");
  });
});
