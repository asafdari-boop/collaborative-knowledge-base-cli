import { describe, expect, it } from "vitest";
import { renderObsidianGraphSettings } from "../../src/index.js";

describe("Obsidian settings", () => {
  it("keeps support files and protected orphan stubs out of the default graph", () => {
    expect(JSON.parse(renderObsidianGraphSettings())).toMatchObject({
      showAttachments: false,
      hideUnresolved: true,
      showOrphans: false,
    });
  });
});
