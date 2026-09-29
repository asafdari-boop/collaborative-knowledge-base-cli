import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePage, sha256 } from "../../src/index.js";
import { allocateSourcePaths } from "../../src/normalization/source-id.js";
import { normalizeNote } from "../../src/normalization/normalize-note.js";
import type { ExtractedNote } from "../../src/index.js";

const parentId = "x-coredata://SYNTHETIC/ICNote/parent";
const childId = "x-coredata://SYNTHETIC/ICNote/child";

function note(overrides: Partial<ExtractedNote> = {}): ExtractedNote {
  return {
    id: parentId,
    title: "Frameworks",
    accountId: "account-icloud",
    accountName: "iCloud",
    folderId: "folder-frameworks",
    folderName: "Frameworks",
    createdAt: "2025-01-01T00:00:00.000Z",
    modifiedAt: "2026-08-23T18:00:00.000Z",
    markdown:
      "# Frameworks\n\nA durable idea links to [Example Thinker](../People/Example-Thinker.md).\n\n[Evidence](Frameworks%20(Attachments)/evidence.txt)\n",
    exportedRelativePath: "iCloud/Frameworks/Frameworks.md",
    accessibility: "readable",
    sensitivity: "permitted",
    attachments: [
      {
        id: "attachment-1",
        uti: "public.plain-text",
        filename: "evidence.txt",
        relativePath: "iCloud/Frameworks/Frameworks (Attachments)/evidence.txt",
        sizeBytes: 27,
      },
    ],
    internalLinks: [
      {
        href: "../People/Example-Thinker.md",
        label: "Example Thinker",
        targetNoteId: childId,
      },
    ],
    ...overrides,
  };
}

async function exportRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ckb-normalize-"));
  const attachment = join(
    root,
    "iCloud/Frameworks/Frameworks (Attachments)/evidence.txt",
  );
  await mkdir(dirname(attachment), { recursive: true });
  await writeFile(attachment, "Synthetic attachment data.\n");
  await writeFile(
    join(root, "iCloud/Frameworks/Frameworks (Attachments)/another.txt"),
    "Second attachment data.\n",
  );
  await writeFile(
    join(root, "iCloud/Frameworks/Frameworks (Attachments)/evidence (2).txt"),
    "Synthetic attachment data.\n",
  );
  return root;
}

describe("note normalization", () => {
  it("emits llmwiki frontmatter, stable links, and attachment plans", async () => {
    const sourcePaths = allocateSourcePaths([parentId, childId]);
    const result = await normalizeNote({
      note: note(),
      sourcePath: sourcePaths.get(parentId) ?? "",
      sourcePaths,
      exportRoot: await exportRoot(),
      capturedAt: "2026-08-24T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
    });
    const parsed = parsePage(result.content);

    expect(parsed.attributes).toMatchObject({
      title: "Frameworks",
      source: `applenotes://${encodeURIComponent(parentId)}`,
      sourceType: "file",
      ingestedAt: "2026-08-24T00:00:00.000Z",
      appleNoteId: parentId,
      createdAt: "2025-01-01T00:00:00.000Z",
      modifiedAt: "2026-08-23T18:00:00.000Z",
      account: "iCloud",
      folder: "Frameworks",
      aliases: [],
    });
    expect(parsed.attributes.contentHash).toBe(result.contentHash);
    expect(parsed.body).toContain(`[[${sourcePaths.get(childId)?.slice(0, -3)}|Example Thinker]]`);
    expect(parsed.body).toMatch(/\[Evidence\]\(\.\.\/\.\.\/Attachments\/[0-9a-f]{64}\.txt\)/);
    expect(result.attachments).toHaveLength(1);
    expect(result.state.generatedHash).toBe(sha256(result.content));
  });

  it("rewrites native Apple Notes URLs as readable Obsidian links", async () => {
    const sourcePaths = allocateSourcePaths([parentId, childId]);
    const href = "applenotes:note/9e42d1d2-a05d-41a6-a7a5-10c62eb864c4?ownerIdentifier=owner";
    const result = await normalizeNote({
      note: note({
        markdown: `Previous link\u2028Example Thinker [${href}]\n`,
        attachments: [],
        internalLinks: [{ href, label: "Example Thinker", targetNoteId: childId }],
      }),
      sourcePath: sourcePaths.get(parentId) ?? "",
      sourcePaths,
      exportRoot: await exportRoot(),
      capturedAt: "2026-08-24T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
    });

    expect(parsePage(result.content).body).toContain(
      `[[${sourcePaths.get(childId)?.slice(0, -3)}|Example Thinker]]`,
    );
    expect(parsePage(result.content).body).not.toContain("applenotes:");
  });

  it("preserves identity, records title aliases, and is byte-stable on no-op refresh", async () => {
    const sourcePaths = allocateSourcePaths([parentId, childId]);
    const root = await exportRoot();
    const first = await normalizeNote({
      note: note(),
      sourcePath: sourcePaths.get(parentId) ?? "",
      sourcePaths,
      exportRoot: root,
      capturedAt: "2026-08-24T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
    });
    const second = await normalizeNote({
      note: note(),
      sourcePath: first.path,
      sourcePaths,
      exportRoot: root,
      capturedAt: "2026-08-25T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
      previous: first.state,
    });

    expect(second.content).toBe(first.content);
    expect(second.state.ingestedAt).toBe(first.state.ingestedAt);

    const renamed = await normalizeNote({
      note: note({ title: "Mental Models", folderName: "Moved" }),
      sourcePath: first.path,
      sourcePaths,
      exportRoot: root,
      capturedAt: "2026-08-26T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
      previous: first.state,
    });
    expect(renamed.path).toBe(first.path);
    expect(renamed.state.aliases).toEqual(["Frameworks"]);
    expect(parsePage(renamed.content).attributes).toMatchObject({
      title: "Mental Models",
      folder: "Moved",
      aliases: ["Frameworks"],
    });
  });

  it("preserves the complete Apple Note body in the first-class Notes layer", async () => {
    const sourcePaths = allocateSourcePaths([parentId]);
    const longBody = "a".repeat(100_005);
    const result = await normalizeNote({
      note: note({
        markdown: longBody,
        attachments: [],
        internalLinks: [],
      }),
      sourcePath: sourcePaths.get(parentId) ?? "",
      sourcePaths,
      exportRoot: await exportRoot(),
      capturedAt: "2026-08-24T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
    });
    const parsed = parsePage(result.content);

    expect(parsed.attributes).not.toHaveProperty("truncated");
    expect(parsed.attributes).not.toHaveProperty("originalChars");
    expect(parsed.body).toContain("<!-- ckb:upstream:start -->");
    expect(parsed.body).toContain(longBody);
  });

  it("lists exported attachments that were not referenced in the source Markdown", async () => {
    const sourcePaths = allocateSourcePaths([parentId]);
    const result = await normalizeNote({
      note: note({ markdown: "# Frameworks\n", internalLinks: [] }),
      sourcePath: sourcePaths.get(parentId) ?? "",
      sourcePaths,
      exportRoot: await exportRoot(),
      capturedAt: "2026-08-24T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
    });
    const attachment = result.attachments[0]!;
    const expectedTarget = `../../${attachment.targetPath}`;

    expect(parsePage(result.content).body).toContain("## Attachments");
    expect(parsePage(result.content).body).toContain(`[evidence.txt](${expectedTarget})`);
  });

  it("renders unlinked attachments in a stable order", async () => {
    const sourcePaths = allocateSourcePaths([parentId]);
    const root = await exportRoot();
    const attachments = [
      ...note().attachments,
      {
        id: "attachment-2",
        uti: "public.plain-text",
        filename: "another.txt",
        relativePath: "iCloud/Frameworks/Frameworks (Attachments)/another.txt",
        sizeBytes: 24,
      },
    ];
    const normalize = (ordered: typeof attachments) => normalizeNote({
      note: note({ markdown: "# Frameworks\n", internalLinks: [], attachments: ordered }),
      sourcePath: sourcePaths.get(parentId) ?? "",
      sourcePaths,
      exportRoot: root,
      capturedAt: "2026-08-24T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
    });

    const forward = await normalize(attachments);
    const reversed = await normalize([...attachments].reverse());

    expect(reversed.content).toBe(forward.content);
  });

  it("normalizes exporter-added attachment collision suffixes", async () => {
    const sourcePaths = allocateSourcePaths([parentId]);
    const root = await exportRoot();
    const original = note({ markdown: "# Frameworks\n", internalLinks: [] });
    const collisionRenamed = note({
      markdown: "# Frameworks\n",
      internalLinks: [],
      attachments: [{
        ...original.attachments[0]!,
        filename: "evidence (2).txt",
        relativePath: "iCloud/Frameworks/Frameworks (Attachments)/evidence (2).txt",
      }],
    });
    const normalize = (value: ExtractedNote) => normalizeNote({
      note: value,
      sourcePath: sourcePaths.get(parentId) ?? "",
      sourcePaths,
      exportRoot: root,
      capturedAt: "2026-08-24T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
    });

    expect((await normalize(collisionRenamed)).content).toBe((await normalize(original)).content);
  });

  it("normalizes exported numeric citations so Obsidian does not create phantom notes", async () => {
    const sourcePaths = allocateSourcePaths([parentId]);
    const result = await normalizeNote({
      note: note({
        markdown: "A claim.[[36]](https://example.com/source#cite_note-36)\n",
        attachments: [],
        internalLinks: [],
      }),
      sourcePath: sourcePaths.get(parentId) ?? "",
      sourcePaths,
      exportRoot: await exportRoot(),
      capturedAt: "2026-08-24T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
    });

    expect(parsePage(result.content).body).toContain(
      "A claim.[36](https://example.com/source#cite_note-36)",
    );
    expect(parsePage(result.content).body).not.toContain("[[36]]");
  });

  it("emits metadata-only stubs for inaccessible and excluded notes", async () => {
    const sourcePaths = allocateSourcePaths([parentId]);
    const inaccessible = await normalizeNote({
      note: note({
        markdown: null,
        exportedRelativePath: null,
        accessibility: "inaccessible",
        attachments: [],
        internalLinks: [],
      }),
      sourcePath: sourcePaths.get(parentId) ?? "",
      sourcePaths,
      exportRoot: await exportRoot(),
      capturedAt: "2026-08-24T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
    });
    expect(parsePage(inaccessible.content).body).toContain("unavailable");
    expect(inaccessible.state.censusStatus).toBe("inaccessible");

    const excluded = await normalizeNote({
      note: note({ sensitivity: "excluded", attachments: [] }),
      sourcePath: sourcePaths.get(parentId) ?? "",
      sourcePaths,
      exportRoot: await exportRoot(),
      capturedAt: "2026-08-24T00:00:00.000Z",
      attachmentMaxBytes: 1_000,
    });
    expect(parsePage(excluded.content).body).not.toContain("durable idea");
    expect(excluded.state.censusStatus).toBe("excluded");
  });
});
