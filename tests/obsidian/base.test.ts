import { describe, expect, it } from "vitest";
import { renderAllNotesBase, renderObsidianGraphSettings } from "../../src/index.js";

describe("Obsidian graph-facing configuration", () => {
  it("renders a dynamic all-notes view without graph-producing wikilinks", () => {
    const base = renderAllNotesBase();
    expect(base).toContain('file.inFolder("Notes")');
    expect(base).toContain("primaryMoc");
    expect(base).not.toContain("[[");
  });

  it("excludes machine and attachment folders from the global graph", () => {
    const settings = JSON.parse(renderObsidianGraphSettings());
    expect(settings.search).toContain("-path:Attachments");
    expect(settings.search).toContain("-path:Reviews");
    expect(settings.search).toContain("-path:System");
    expect(settings.search).toContain("-path:.ckb");
  });
});
