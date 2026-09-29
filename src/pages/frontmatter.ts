import { parseDocument } from "yaml";
import { InvalidFrontmatterError } from "../core/errors.js";
import { newPageId } from "../core/ids.js";

export interface ParsedPage {
  id?: string;
  attributes: Record<string, unknown>;
  body: string;
}

export interface EnsuredPageId {
  id: string;
  content: string;
  changed: boolean;
}

interface FrontmatterBlock {
  attributes: Record<string, unknown>;
  body: string;
  closingMarkerIndex: number;
  newline: "\n" | "\r\n";
}

function readFrontmatter(raw: string): FrontmatterBlock | undefined {
  const match = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return undefined;

  const yamlText = match[2] ?? "";
  const document = parseDocument(yamlText, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new InvalidFrontmatterError(document.errors.map((error) => error.message).join("; "));
  }
  const value = document.toJS() as unknown;
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new InvalidFrontmatterError("Page frontmatter must be a YAML mapping");
  }

  const fullMatch = match[0];
  const closingMarkerIndex = fullMatch.lastIndexOf("---");
  return {
    attributes: (value ?? {}) as Record<string, unknown>,
    body: raw.slice(fullMatch.length),
    closingMarkerIndex,
    newline: match[1] === "\r\n" ? "\r\n" : "\n",
  };
}

function validatedPageId(attributes: Record<string, unknown>): string | undefined {
  if (!("ckb_id" in attributes)) return undefined;
  const id = attributes.ckb_id;
  if (typeof id !== "string" || !id.startsWith("page:")) {
    throw new InvalidFrontmatterError("ckb_id must be a string beginning with page:");
  }
  return id;
}

export function parsePage(raw: string): ParsedPage {
  const frontmatter = readFrontmatter(raw);
  if (!frontmatter) return { attributes: {}, body: raw };
  const id = validatedPageId(frontmatter.attributes);
  return id === undefined
    ? { attributes: frontmatter.attributes, body: frontmatter.body }
    : { id, attributes: frontmatter.attributes, body: frontmatter.body };
}

export function ensurePageId(raw: string, suppliedId?: string): EnsuredPageId {
  const frontmatter = readFrontmatter(raw);
  if (frontmatter) {
    const existingId = validatedPageId(frontmatter.attributes);
    if (existingId !== undefined) {
      return { id: existingId, content: raw, changed: false };
    }
    const id = suppliedId ?? newPageId();
    if (!id.startsWith("page:")) {
      throw new InvalidFrontmatterError("New page IDs must begin with page:");
    }
    const insertion = `ckb_id: ${id}${frontmatter.newline}`;
    return {
      id,
      content:
        raw.slice(0, frontmatter.closingMarkerIndex) +
        insertion +
        raw.slice(frontmatter.closingMarkerIndex),
      changed: true,
    };
  }

  const id = suppliedId ?? newPageId();
  if (!id.startsWith("page:")) {
    throw new InvalidFrontmatterError("New page IDs must begin with page:");
  }
  return {
    id,
    content: `---\nckb_id: ${id}\n---\n${raw}`,
    changed: true,
  };
}
