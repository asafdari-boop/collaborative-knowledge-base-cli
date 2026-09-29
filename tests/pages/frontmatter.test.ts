import { describe, expect, it } from "vitest";
import { ensurePageId, parsePage } from "../../src/index.js";

const fixedId = "page:00000000-0000-4000-8000-000000000001";

describe("page frontmatter", () => {
  it("injects one stable ID while preserving existing Markdown", () => {
    const raw = "---\ntitle: Frameworks\ntags:\n  - thinking\n---\n# Frameworks\n\nHuman text.\n";

    const first = ensurePageId(raw, fixedId);
    const second = ensurePageId(first.content);

    expect(first).toEqual({
      id: fixedId,
      changed: true,
      content: `---\ntitle: Frameworks\ntags:\n  - thinking\nckb_id: ${fixedId}\n---\n# Frameworks\n\nHuman text.\n`,
    });
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
    expect(parsePage(first.content).id).toBe(fixedId);
  });

  it("prepends minimal frontmatter when none exists", () => {
    const raw = "# New page\n\nUntouched body.\n";

    const result = ensurePageId(raw, fixedId);

    expect(result.content).toBe(`---\nckb_id: ${fixedId}\n---\n${raw}`);
  });

  it("rejects duplicate or non-string page IDs", () => {
    expect(() => parsePage("---\nckb_id: page:one\nckb_id: page:two\n---\nBody\n")).toThrow();
    expect(() => parsePage("---\nckb_id:\n  nested: value\n---\nBody\n")).toThrow();
  });
});
