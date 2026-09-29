import { stringify } from "yaml";

export interface SourceFrontmatter {
  title: string;
  source: string;
  sourceType: "file";
  ingestedAt: string;
  appleNoteId: string;
  createdAt: string;
  modifiedAt: string;
  account: string;
  folder: string;
  contentHash: string;
  attachmentHashes: string[];
  aliases: string[];
  truncated?: true;
  originalChars?: number;
  withheld?: true;
  withheldReason?: "inaccessible" | "excluded";
}

export function renderSource(frontmatter: SourceFrontmatter, body: string): string {
  const yaml = stringify(frontmatter, { lineWidth: 0 });
  return `---\n${yaml}---\n${body}`;
}
