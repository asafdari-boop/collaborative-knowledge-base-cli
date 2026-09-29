import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { planAttachments } from "../../src/normalization/attachments.js";
import type { ExtractedAttachment } from "../../src/index.js";

async function fixtureAttachment(bytes: Buffer): Promise<{
  exportRoot: string;
  attachment: ExtractedAttachment;
}> {
  const exportRoot = await mkdtemp(join(tmpdir(), "ckb-attachment-"));
  const relativePath = "iCloud/Research/Note (Attachments)/evidence.txt";
  const absolutePath = join(exportRoot, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  return {
    exportRoot,
    attachment: {
      id: "attachment-1",
      uti: "public.plain-text",
      filename: "evidence.txt",
      relativePath,
      sizeBytes: bytes.length,
    },
  };
}

describe("content-addressed attachments", () => {
  it("deduplicates repeated bytes at a hash-based target", async () => {
    const fixture = await fixtureAttachment(Buffer.from("same bytes\n"));
    const first = await planAttachments([fixture.attachment], fixture.exportRoot, 1_000);
    const second = await planAttachments([fixture.attachment], fixture.exportRoot, 1_000);

    expect(first).toHaveLength(1);
    expect(first[0]?.targetPath).toMatch(/^Attachments\/[0-9a-f]{64}\.txt$/);
    expect(second[0]?.targetPath).toBe(first[0]?.targetPath);
    expect(second[0]?.content.equals(first[0]?.content ?? Buffer.alloc(0))).toBe(true);
  });

  it("rejects attachments over the configured size limit", async () => {
    const fixture = await fixtureAttachment(Buffer.from("too large"));

    await expect(
      planAttachments([fixture.attachment], fixture.exportRoot, 2),
    ).rejects.toMatchObject({ code: "attachment_too_large" });
  });
});
