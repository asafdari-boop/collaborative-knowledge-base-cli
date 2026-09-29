export interface ManagedRegions {
  upstream: string;
  connections: string;
  local: string;
}

export type ManagedRegionMergeStatus = "clean" | "local_divergence" | "conflict";

const BOUNDARIES = [
  "<!-- ckb:upstream:start -->",
  "<!-- ckb:upstream:end -->",
  "<!-- ckb:connections:start -->",
  "<!-- ckb:connections:end -->",
  "<!-- ckb:local:start -->",
  "<!-- ckb:local:end -->",
] as const;

function normalizedRegion(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

export function renderManagedRegions(regions: ManagedRegions): string {
  return [
    BOUNDARIES[0],
    normalizedRegion(regions.upstream) + BOUNDARIES[1],
    "",
    BOUNDARIES[2],
    normalizedRegion(regions.connections) + BOUNDARIES[3],
    "",
    BOUNDARIES[4],
    normalizedRegion(regions.local) + BOUNDARIES[5],
    "",
  ].join("\n");
}

function occurrences(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

function between(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  return content.slice(startIndex + start.length + 1, endIndex);
}

export function parseManagedRegions(content: string): ManagedRegions {
  for (const boundary of BOUNDARIES) {
    const count = occurrences(content, boundary);
    if (count === 0) throw new Error(`Managed note boundaries are missing ${boundary}`);
    if (count > 1) throw new Error(`Managed note contains a duplicate boundary ${boundary}`);
  }
  const positions = BOUNDARIES.map((boundary) => content.indexOf(boundary));
  if (!positions.every((position, index) => index === 0 || position > positions[index - 1]!)) {
    throw new Error("Managed note boundaries are out of order");
  }
  return {
    upstream: between(content, BOUNDARIES[0], BOUNDARIES[1]),
    connections: between(content, BOUNDARIES[2], BOUNDARIES[3]),
    local: between(content, BOUNDARIES[4], BOUNDARIES[5]),
  };
}

export function mergeManagedRegions(input: {
  base: ManagedRegions;
  live: ManagedRegions;
  next: ManagedRegions;
}): { status: ManagedRegionMergeStatus; regions: ManagedRegions } {
  const localUpstreamChanged = input.live.upstream !== input.base.upstream;
  const remoteUpstreamChanged = input.next.upstream !== input.base.upstream;
  if (
    localUpstreamChanged &&
    remoteUpstreamChanged &&
    input.live.upstream !== input.next.upstream
  ) {
    return { status: "conflict", regions: input.live };
  }
  const upstream = localUpstreamChanged && !remoteUpstreamChanged
    ? input.live.upstream
    : input.next.upstream;
  const connections = input.live.connections !== input.base.connections
    ? input.live.connections
    : input.next.connections;
  return {
    status: localUpstreamChanged && !remoteUpstreamChanged ? "local_divergence" : "clean",
    regions: { upstream, connections, local: input.live.local },
  };
}

export const MANAGED_REGION_BOUNDARIES = BOUNDARIES;
