import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import {
  AttachmentTooLargeError,
  MalformedExportError,
} from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { assertNoSymlinkAncestors, resolveInside } from "../core/paths.js";
import type { ExtractedAttachment } from "../extractors/types.js";

export interface AttachmentPlan {
  attachmentId: string;
  originalRelativePath: string;
  targetPath: string;
  hash: string;
  uti: string;
  filename?: string;
  content: Buffer;
}

function safeExtension(attachment: ExtractedAttachment): string {
  const candidate = posix.extname(attachment.filename ?? attachment.relativePath).slice(1);
  return /^[a-z0-9]{1,16}$/i.test(candidate) ? candidate.toLowerCase() : "bin";
}

export async function planAttachments(
  attachments: ExtractedAttachment[],
  exportRoot: string,
  maxBytes: number,
): Promise<AttachmentPlan[]> {
  const plans: AttachmentPlan[] = [];
  for (const attachment of attachments) {
    const absolutePath = resolveInside(exportRoot, attachment.relativePath);
    await assertNoSymlinkAncestors(exportRoot, absolutePath);
    const metadata = await stat(absolutePath).catch(() => null);
    if (!metadata?.isFile()) {
      throw new MalformedExportError(`Attachment is missing: ${attachment.relativePath}`);
    }
    if (metadata.size !== attachment.sizeBytes) {
      throw new MalformedExportError(
        `Attachment size changed after extraction: ${attachment.relativePath}`,
      );
    }
    if (metadata.size > maxBytes) {
      throw new AttachmentTooLargeError(attachment.relativePath, metadata.size, maxBytes);
    }
    const content = await readFile(absolutePath);
    const hash = sha256(content);
    plans.push({
      attachmentId: attachment.id,
      originalRelativePath: attachment.relativePath,
      targetPath: `Attachments/${hash}.${safeExtension(attachment)}`,
      hash,
      uti: attachment.uti,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      content,
    });
  }
  return plans;
}
