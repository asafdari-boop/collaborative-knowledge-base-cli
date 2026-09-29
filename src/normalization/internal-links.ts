import { posix } from "node:path";
import type { ExtractedInternalLink } from "../extractors/types.js";
import type { AttachmentPlan } from "./attachments.js";

const MARKDOWN_LINK =
  /(!?)\[([^\]]*)\]\(((?:[^\s()]|\([^)]*\))+)(?:\s+"[^"]*")?\)/g;

function sourceStem(path: string): string {
  return path.replace(/\.md$/, "");
}

export function rewriteInternalNoteLinks(
  markdown: string,
  internalLinks: ExtractedInternalLink[],
  sourcePaths: ReadonlyMap<string, string>,
): string {
  const byHref = new Map(internalLinks.map((link) => [link.href, link]));
  const nativeRewritten = markdown.replace(
    /(^|[\n\u2028\u2029])([^\n\u2028\u2029]*?)\s*\[(applenotes:(?:\/\/)?[^\]\n\u2028\u2029]+)\]/gi,
    (full, lineStart: string, rawLabel: string, href: string) => {
      const link = byHref.get(href);
      if (!link?.targetNoteId) return full;
      const target = sourcePaths.get(link.targetNoteId);
      if (!target) return full;
      const label = link.label || rawLabel.trim() || sourceStem(target);
      return `${lineStart}[[${sourceStem(target)}|${label}]]`;
    },
  );
  const markdownRewritten = nativeRewritten.replace(
    MARKDOWN_LINK,
    (full, image: string, label: string, href: string) => {
      if (image) return full;
      const link = byHref.get(href);
      if (!link?.targetNoteId) return full;
      const target = sourcePaths.get(link.targetNoteId);
      if (!target) return full;
      return `[[${sourceStem(target)}|${label || link.label || sourceStem(target)}]]`;
    },
  );
  const byWikiTarget = new Map<string, ExtractedInternalLink>();
  for (const link of internalLinks) {
    let decoded = link.href;
    try {
      decoded = decodeURIComponent(link.href);
    } catch {
      // Keep the original href when it is not valid percent encoding.
    }
    byWikiTarget.set(decoded.replace(/\.md(?:[?#].*)?$/i, ""), link);
  }
  return markdownRewritten.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (full, wikiTarget: string, label: string | undefined) => {
      const link = byWikiTarget.get(wikiTarget);
      if (!link?.targetNoteId) return full;
      const target = sourcePaths.get(link.targetNoteId);
      if (!target) return full;
      return `[[${sourceStem(target)}|${label || link.label || sourceStem(target)}]]`;
    },
  );
}

function decodedPath(href: string): string | null {
  const withoutFragment = href.split(/[?#]/, 1)[0] ?? "";
  if (!withoutFragment || /^[a-z][a-z0-9+.-]*:/i.test(withoutFragment)) return null;
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return null;
  }
}

export function rewriteAttachmentLinks(
  markdown: string,
  exportedNotePath: string,
  sourcePath: string,
  attachments: AttachmentPlan[],
): string {
  const byExportPath = new Map(
    attachments.map((attachment) => [
      posix.normalize(attachment.originalRelativePath),
      attachment.targetPath,
    ]),
  );
  return markdown.replace(MARKDOWN_LINK, (full, image: string, label: string, href: string) => {
    const decoded = decodedPath(href);
    if (decoded === null) return full;
    const resolved = posix.normalize(posix.join(posix.dirname(exportedNotePath), decoded));
    const target = byExportPath.get(resolved);
    if (!target) return full;
    const relativeTarget = posix.relative(posix.dirname(sourcePath), target);
    return `${image}[${label}](${relativeTarget})`;
  });
}

export function appendUnlinkedAttachmentReferences(
  markdown: string,
  sourcePath: string,
  attachments: AttachmentPlan[],
): string {
  const missing = [...new Map(attachments.map((attachment) => [attachment.targetPath, attachment]))
    .values()]
    .map((attachment) => ({
      attachment,
      relativeTarget: posix.relative(posix.dirname(sourcePath), attachment.targetPath),
    }))
    .filter(({ relativeTarget }) => !markdown.includes(`(${relativeTarget})`))
    .sort((left, right) => left.relativeTarget.localeCompare(right.relativeTarget));
  if (missing.length === 0) return markdown;
  const links = missing.map(({ attachment, relativeTarget }) => {
    const label = (attachment.filename ?? posix.basename(attachment.originalRelativePath))
      .replace(/\s+\(\d+\)(?=\.[^.]+$)/, "");
    const image = /\.(?:avif|gif|jpe?g|png|webp)$/i.test(relativeTarget) ? "!" : "";
    return `- ${image}[${label}](${relativeTarget})`;
  });
  return `${markdown.trimEnd()}\n\n## Attachments\n\n${links.join("\n")}\n`;
}
