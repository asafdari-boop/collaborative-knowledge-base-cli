import { sha256 } from "../core/hash.js";
import { parsePage } from "../pages/frontmatter.js";
import { stringify } from "yaml";
import type { SourceState } from "../state/types.js";
import {
  parseManagedRegions,
  renderManagedRegions,
  type ManagedRegions,
  type ManagedRegionMergeStatus,
} from "./managed-regions.js";

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

function replaceBody(page: string, body: string): string {
  const frontmatter = FRONTMATTER.exec(page);
  if (!frontmatter) return body;
  return `${frontmatter[0]}${body}`;
}

export interface ReconciledFirstClassPage {
  status: ManagedRegionMergeStatus;
  content: string;
  regions: ManagedRegions;
  generatedConnectionsHash: string;
}

export function reconcileFirstClassPage(input: {
  previous: SourceState;
  liveContent: string;
  nextContent: string;
}): ReconciledFirstClassPage {
  const liveRegions = parseManagedRegions(parsePage(input.liveContent).body);
  const nextRegions = parseManagedRegions(parsePage(input.nextContent).body);
  const previousUpstreamHash = input.previous.upstreamRegionHash;
  const previousConnectionsHash = input.previous.connectionsRegionHash;
  if (!previousUpstreamHash || !previousConnectionsHash) {
    throw new Error("Previous source state has no managed-region hashes");
  }

  const localUpstreamChanged = sha256(liveRegions.upstream) !== previousUpstreamHash;
  const remoteUpstreamChanged = sha256(nextRegions.upstream) !== previousUpstreamHash;
  if (
    localUpstreamChanged &&
    remoteUpstreamChanged &&
    liveRegions.upstream !== nextRegions.upstream
  ) {
    return {
      status: "conflict",
      content: input.liveContent,
      regions: liveRegions,
      generatedConnectionsHash: sha256(nextRegions.connections),
    };
  }

  const regions: ManagedRegions = {
    upstream: localUpstreamChanged && !remoteUpstreamChanged
      ? liveRegions.upstream
      : nextRegions.upstream,
    connections: sha256(liveRegions.connections) !== previousConnectionsHash
      ? liveRegions.connections
      : nextRegions.connections,
    local: liveRegions.local,
  };
  const status: ManagedRegionMergeStatus = localUpstreamChanged && !remoteUpstreamChanged
    ? "local_divergence"
    : "clean";
  return {
    status,
    regions,
    content: replaceBody(input.nextContent, renderManagedRegions(regions)),
    generatedConnectionsHash: sha256(nextRegions.connections),
  };
}

function fullWikilinks(content: string): string[] {
  return [...content.matchAll(/\[\[[^\]]+\]\]/g)].map((match) => match[0]);
}

export function updateFirstClassPageGraph(input: {
  content: string;
  generatedConnections: string;
  primaryMocTitle: string;
  secondaryMocTitles: string[];
  generatedConnectionsBaseHash?: string;
}): { content: string; connections: string } {
  const parsed = parsePage(input.content);
  const regions = parseManagedRegions(parsed.body);
  const generatedLinks = new Set(fullWikilinks(input.generatedConnections));
  const humanChanged = input.generatedConnectionsBaseHash !== undefined &&
    sha256(regions.connections) !== input.generatedConnectionsBaseHash;
  const curatedLinks = humanChanged
    ? fullWikilinks(regions.connections).filter((candidate) => !generatedLinks.has(candidate))
    : [];
  const connections = curatedLinks.length
    ? `${input.generatedConnections.trimEnd()}\n\n### Curated connections\n\n${[...new Set(curatedLinks)].map((candidate) => `- ${candidate}`).join("\n")}\n`
    : input.generatedConnections;
  const attributes = {
    ...parsed.attributes,
    primaryMoc: input.primaryMocTitle,
    secondaryMocs: input.secondaryMocTitles,
    syncStatus: "clean",
  };
  return {
    content: `---\n${stringify(attributes, { lineWidth: 0 })}---\n${renderManagedRegions({
      ...regions,
      connections,
    })}`,
    connections,
  };
}

export function replaceFirstClassPageConnections(
  content: string,
  generatedConnections: string,
): string {
  const parsed = parsePage(content);
  const regions = parseManagedRegions(parsed.body);
  return replaceBody(content, renderManagedRegions({
    ...regions,
    connections: generatedConnections,
  }));
}
