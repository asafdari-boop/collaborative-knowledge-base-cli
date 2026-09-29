import { extractWikilinkTargets } from "./validate.js";
import type { RenderedGraphPage } from "./render.js";

export interface GraphMetrics {
  nodes: number;
  edges: number;
  components: number;
  isolates: string[];
  degreeDistribution: number[];
  highestDegree: Array<{ path: string; degree: number }>;
}

export function calculateGraphMetrics(pages: RenderedGraphPage[]): GraphMetrics {
  const pathByStem = new Map(pages.map((page) => [page.path.replace(/\.md$/, ""), page.path]));
  const adjacency = new Map(pages.map((page) => [page.path, new Set<string>()]));
  const edgeKeys = new Set<string>();
  for (const page of pages) {
    for (const target of extractWikilinkTargets(page.content)) {
      const resolved = pathByStem.get(target.replace(/\.md$/, ""));
      if (!resolved || resolved === page.path) continue;
      adjacency.get(page.path)!.add(resolved);
      adjacency.get(resolved)!.add(page.path);
      edgeKeys.add([page.path, resolved].sort().join("\u0000"));
    }
  }
  const isolates = pages.filter((page) => adjacency.get(page.path)!.size === 0).map((page) => page.path);
  const seen = new Set<string>();
  let components = 0;
  for (const page of pages) {
    if (seen.has(page.path)) continue;
    components += 1;
    const stack = [page.path];
    while (stack.length) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...adjacency.get(current)!);
    }
  }
  const maxDegree = Math.max(0, ...[...adjacency.values()].map((neighbors) => neighbors.size));
  const degreeDistribution = Array.from({ length: maxDegree + 1 }, () => 0);
  for (const neighbors of adjacency.values()) degreeDistribution[neighbors.size] = (degreeDistribution[neighbors.size] ?? 0) + 1;
  const order = new Map(pages.map((page, index) => [page.path, index]));
  const highestDegree = pages.map((page) => ({ path: page.path, degree: adjacency.get(page.path)!.size }))
    .sort((left, right) => right.degree - left.degree || order.get(left.path)! - order.get(right.path)!)
    .slice(0, 20);
  return { nodes: pages.length, edges: edgeKeys.size, components, isolates, degreeDistribution, highestDegree };
}
