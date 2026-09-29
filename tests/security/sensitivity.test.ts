import { describe, expect, it } from "vitest";
import { applySensitivity, redactSecrets } from "../../src/security/sensitivity.js";
import type { ExtractedNote } from "../../src/index.js";

function note(overrides: Partial<ExtractedNote> = {}): ExtractedNote {
  return {
    id: "note-public",
    title: "API setup",
    accountId: "account",
    accountName: "iCloud",
    folderId: "folder",
    folderName: "Research",
    createdAt: "2025-01-01T00:00:00.000Z",
    modifiedAt: "2026-08-24T00:00:00.000Z",
    markdown: "Normal context.\n",
    exportedRelativePath: "iCloud/Research/API setup.md",
    accessibility: "readable",
    sensitivity: "permitted",
    attachments: [],
    internalLinks: [],
    ...overrides,
  };
}

describe("sensitivity filtering", () => {
  it("redacts credential-like values while preserving surrounding prose", () => {
    const input = [
      "Normal context remains.",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "password: correct-horse-battery-staple",
      "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN PRIVATE KEY-----",
      "sensitive-material",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n");

    const result = redactSecrets(input);

    expect(result.redactions).toBeGreaterThanOrEqual(4);
    expect(result.content).toContain("Normal context remains.");
    expect(result.content).toContain("[REDACTED_SECRET]");
    expect(result.content).not.toContain("correct-horse");
    expect(result.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.content).not.toContain("sensitive-material");
    expect(redactSecrets(result.content).content).toBe(result.content);
  });

  it("keeps redaction markers idempotent when followed by punctuation", () => {
    const alreadyRedacted = "title: exa = Exa(api_key=[REDACTED_SECRET])\n";
    expect(redactSecrets(alreadyRedacted).content).toBe(alreadyRedacted);
  });

  it("keeps redaction markers idempotent inside serialized filenames", () => {
    const alreadyRedacted = JSON.stringify({
      path: "Notes/exa = Exa(api_key=[REDACTED_SECRET]).md",
    });
    expect(redactSecrets(alreadyRedacted)).toEqual({
      content: alreadyRedacted,
      redactions: 0,
    });
  });

  it("redacts unlabeled high-entropy passwords, labeled card secrets, and valid card numbers", () => {
    const input = [
      "Useful operating context remains.",
      "Consult@nt2024*AS!!!",
      "CVC 952",
      "Card: 4242 4242 4242 4242",
      "Reference number: 1234 5678 9012 3456",
      "",
    ].join("\n");

    const result = redactSecrets(input);

    expect(result.redactions).toBe(4);
    expect(result.content).toContain("Useful operating context remains.");
    expect(result.content).not.toContain("Consult@nt2024");
    expect(result.content).not.toContain("CVC 952");
    expect(result.content).not.toContain("4242 4242 4242 4242");
    expect(result.content).not.toContain("1234 5678 9012 3456");
  });

  it("does not mistake a numeric image URL path for a card number", () => {
    const input = "![Image](https://example.com/4242-4242-4242-4242-a1.png)";
    expect(redactSecrets(input)).toEqual({ content: input, redactions: 0 });
  });

  it("excludes configured IDs and title patterns before compilation", () => {
    const byId = applySensitivity(note({ id: "private-note" }), {
      excludedNoteIds: ["private-note"],
      excludedTitlePatterns: [],
      redactSecrets: true,
    });
    const byTitle = applySensitivity(note({ title: "Passwords" }), {
      excludedNoteIds: [],
      excludedTitlePatterns: ["^Passwords$"],
      redactSecrets: true,
    });

    expect(byId.note.sensitivity).toBe("excluded");
    expect(byId.reasons).toEqual(["note_id"]);
    expect(byTitle.note.sensitivity).toBe("excluded");
    expect(byTitle.reasons).toEqual(["title_pattern"]);
  });

  it("still redacts sensitive metadata when the note body is excluded", () => {
    const secret = "realistic-secret-value-123";
    const result = applySensitivity(note({
      title: `SDK api_key=${secret}`,
      accountName: `Account password=${secret}`,
      folderName: `Folder access_token=${secret}`,
      markdown: `Body password=${secret}`,
      internalLinks: [{ href: "applenotes://target", targetNoteId: "target", label: `api_key=${secret}` }],
    }), {
      excludedNoteIds: [],
      excludedTitlePatterns: ["api[_ -]?key"],
      redactSecrets: true,
    });

    expect(result.note.sensitivity).toBe("excluded");
    expect(result.note.title).not.toContain(secret);
    expect(result.note.accountName).not.toContain(secret);
    expect(result.note.folderName).not.toContain(secret);
    expect(result.note.internalLinks[0]?.label).not.toContain(secret);
    expect(result.note.markdown).toContain(secret);
    expect(result.redactions).toBe(4);
  });

  it("rejects invalid configured title patterns", () => {
    expect(() =>
      applySensitivity(note(), {
        excludedNoteIds: [],
        excludedTitlePatterns: ["["],
        redactSecrets: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_sensitivity_pattern" }));
  });
});
