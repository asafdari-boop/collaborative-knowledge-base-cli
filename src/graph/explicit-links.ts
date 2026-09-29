import type { ExtractedInternalLink } from "../extractors/types.js";
import type { RelationshipState } from "../state/types.js";
import { sourceIdentity } from "../normalization/source-id.js";
import { createRelationship } from "./relationship.js";

export interface SourceReference {
  sourceId: string;
  noteIdHash: string;
  title: string;
  aliases: string[];
  path: string;
}

export interface SourceReferenceIndex {
  byNormalizedTitle: Map<string, SourceReference[]>;
  bySourceId: Map<string, SourceReference>;
}

export type TitleResolution =
  | { status: "resolved"; sourceId: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "missing" };

export interface UnresolvedExplicitReference {
  status: "ambiguous" | "missing";
  sourceId: string;
  label: string;
  candidates: string[];
  origin: "double-arrow" | "apple-link";
}

function decodedText(value: string): string {
  return value
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function normalizeReferenceTitle(value: string): string {
  let normalized = decodedText(value).normalize("NFKC").trim();
  const wikilink = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(normalized);
  if (wikilink) normalized = wikilink[2] ?? wikilink[1] ?? normalized;
  normalized = normalized
    .replace(/^(?:\*\*|__|`)+|(?:\*\*|__|`)+$/g, "")
    .replace(/(?:\*\*|__|`)/g, "")
    .replace(/\.md$/i, "")
    .replace(/[.,;:!?]+$/g, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
  return normalized;
}

export function buildSourceReferenceIndex(sources: SourceReference[]): SourceReferenceIndex {
  const byNormalizedTitle = new Map<string, SourceReference[]>();
  const bySourceId = new Map<string, SourceReference>();
  for (const source of sources) {
    bySourceId.set(source.sourceId, source);
    for (const title of [source.title, ...source.aliases]) {
      const key = normalizeReferenceTitle(title);
      if (!key) continue;
      const current = byNormalizedTitle.get(key) ?? [];
      if (!current.some((candidate) => candidate.sourceId === source.sourceId)) current.push(source);
      byNormalizedTitle.set(key, current);
    }
  }
  return { byNormalizedTitle, bySourceId };
}

export function resolveTitleReference(value: string, index: SourceReferenceIndex): TitleResolution {
  const normalized = normalizeReferenceTitle(value);
  let candidates = index.byNormalizedTitle.get(normalized) ?? [];
  if (candidates.length === 0 && normalized.length >= 8) {
    const boundaryPrefix = (shorter: string, longer: string): boolean =>
      longer.startsWith(shorter) && /^[\s(\[\-–—]/.test(longer.slice(shorter.length, shorter.length + 1));
    candidates = [...index.byNormalizedTitle.entries()]
      .filter(([candidate]) => boundaryPrefix(normalized, candidate) || boundaryPrefix(candidate, normalized))
      .flatMap(([, matches]) => matches);
  }
  const ids = [...new Set(candidates.map((candidate) => candidate.sourceId))].sort();
  if (ids.length === 1) return { status: "resolved", sourceId: ids[0]! };
  if (ids.length > 1) return { status: "ambiguous", candidates: ids };
  return { status: "missing" };
}

export function extractDoubleArrowReferences(markdown: string): string[] {
  const references: string[] = [];
  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    let line = rawLine.trim().replace(/^[-*+]\s+/, "");
    if (/^(?:\*\*|__)/.test(line)) line = line.slice(2);
    if (/(?:\*\*|__)$/.test(line)) line = line.slice(0, -2);
    const match = /^(?:>>|&gt;&gt;)\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const label = (match[1] ?? "").replace(/^(?:\*\*|__)|(?:\*\*|__)$/g, "").trim();
    if (label) references.push(label);
  }
  return references;
}

function unresolved(
  sourceId: string,
  label: string,
  resolution: Exclude<TitleResolution, { status: "resolved" }>,
  origin: UnresolvedExplicitReference["origin"],
): UnresolvedExplicitReference {
  return {
    status: resolution.status,
    sourceId,
    label,
    candidates: resolution.status === "ambiguous" ? resolution.candidates : [],
    origin,
  };
}

export function resolveExplicitRelationships(input: {
  source: SourceReference;
  markdown: string;
  internalLinks: ExtractedInternalLink[];
  index: SourceReferenceIndex;
}): { relationships: RelationshipState[]; unresolved: UnresolvedExplicitReference[] } {
  const relationships = new Map<string, RelationshipState>();
  const unresolvedReferences: UnresolvedExplicitReference[] = [];
  for (const label of extractDoubleArrowReferences(input.markdown)) {
    const resolution = resolveTitleReference(label, input.index);
    if (resolution.status !== "resolved") {
      unresolvedReferences.push(unresolved(input.source.sourceId, label, resolution, "double-arrow"));
      continue;
    }
    if (resolution.sourceId === input.source.sourceId) continue;
    const relationship = createRelationship({
      fromId: input.source.sourceId,
      toId: resolution.sourceId,
      kind: "child",
      origin: "explicit",
    });
    relationships.set(relationship.relationshipId, relationship);
  }
  for (const link of input.internalLinks) {
    if (!link.targetNoteId) continue;
    const targetId = sourceIdentity(link.targetNoteId).sourceId;
    if (!input.index.bySourceId.has(targetId)) {
      unresolvedReferences.push({
        status: "missing",
        sourceId: input.source.sourceId,
        label: link.label || link.href,
        candidates: [],
        origin: "apple-link",
      });
      continue;
    }
    if (targetId === input.source.sourceId) continue;
    const relationship = createRelationship({
      fromId: input.source.sourceId,
      toId: targetId,
      kind: "related",
      origin: "explicit",
    });
    relationships.set(relationship.relationshipId, relationship);
  }
  const uniqueUnresolved = new Map<string, UnresolvedExplicitReference>();
  for (const reference of unresolvedReferences) {
    const key = [
      reference.sourceId,
      reference.status,
      normalizeReferenceTitle(reference.label),
      ...reference.candidates,
    ].join("\u0000");
    const previous = uniqueUnresolved.get(key);
    if (!previous || reference.origin === "apple-link") uniqueUnresolved.set(key, reference);
  }
  return { relationships: [...relationships.values()], unresolved: [...uniqueUnresolved.values()] };
}

export function renderExplicitConnections(
  sourceId: string,
  relationships: RelationshipState[],
  index: SourceReferenceIndex,
): string {
  const link = (id: string) => {
    const target = index.bySourceId.get(id);
    return target ? `[[${target.path.replace(/\.md$/, "")}|${target.title}]]` : null;
  };
  const parents = relationships
    .filter((edge) => edge.kind === "child" && edge.toId === sourceId && !edge.rejected)
    .map((edge) => link(edge.fromId)).filter((value): value is string => value !== null);
  const children = relationships
    .filter((edge) => edge.kind === "child" && edge.fromId === sourceId && !edge.rejected)
    .map((edge) => link(edge.toId)).filter((value): value is string => value !== null);
  const related = relationships
    .filter((edge) => edge.kind === "related" && (edge.fromId === sourceId || edge.toId === sourceId) && !edge.rejected)
    .map((edge) => link(edge.fromId === sourceId ? edge.toId : edge.fromId))
    .filter((value): value is string => value !== null);
  const lines = ["## Connections", ""];
  if (parents.length) lines.push(`- Parent: ${[...new Set(parents)].sort().join(", ")}`);
  if (children.length) lines.push(`- Children: ${[...new Set(children)].sort().join(", ")}`);
  if (related.length) lines.push(`- Related: ${[...new Set(related)].sort().join(", ")}`);
  return `${lines.join("\n")}\n`;
}
