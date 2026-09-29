import { stringify } from "yaml";
import type { GraphAssignment, GraphWikiPage } from "../compiler/graph-schema.js";
import type { RelationshipState, SourceState } from "../state/types.js";
import type { Taxonomy, MocDefinition } from "./taxonomy.js";

export interface RenderedGraphPage {
  path: string;
  content: string;
}

export interface RenderedSourceConnections {
  sourceId: string;
  content: string;
  parentMocPaths: string[];
}

export interface RenderKnowledgeGraphInput {
  taxonomy: Taxonomy;
  sources: SourceState[];
  assignments: GraphAssignment[];
  relationships: RelationshipState[];
  wikiPages: Array<Pick<GraphWikiPage, "path" | "title" | "summary" | "sourceIds">>;
  mocDirectChildLimit: number;
}

export interface RenderKnowledgeGraphResult {
  pages: RenderedGraphPage[];
  sourceConnections: RenderedSourceConnections[];
}

interface RenderedMocNode {
  slug: string;
  title: string;
  path: string;
  parentSlug?: string;
  sources: SourceState[];
}

function page(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n${body.trimEnd()}\n`;
}

function link(path: string, title: string): string {
  return `[[${path.replace(/\.md$/, "")}|${title}]]`;
}

function sourceMembership(
  mocSlug: string,
  sources: SourceState[],
  assignments: Map<string, GraphAssignment>,
): SourceState[] {
  return sources
    .filter((source) => {
      const assignment = assignments.get(source.sourceId);
      return assignment?.primaryMoc === mocSlug || assignment?.secondaryMocs.includes(mocSlug);
    })
    .sort((left, right) => left.title.localeCompare(right.title) || left.sourceId.localeCompare(right.sourceId));
}

function buildMocNodes(
  definition: MocDefinition,
  members: SourceState[],
  limit: number,
): RenderedMocNode[] {
  const root: RenderedMocNode = {
    slug: definition.slug,
    title: definition.title,
    path: `MOCs/${definition.title}.md`,
    sources: members.length <= limit ? members : [],
  };
  if (members.length <= limit) return [root];
  const collections: RenderedMocNode[] = [];
  for (let index = 0; index < members.length; index += limit) {
    const number = Math.floor(index / limit) + 1;
    const title = `${definition.title} — Collection ${number}`;
    collections.push({
      slug: `${definition.slug}--collection-${number}`,
      title,
      path: `MOCs/${title}.md`,
      parentSlug: definition.slug,
      sources: members.slice(index, index + limit),
    });
  }
  return [root, ...collections];
}

function wikiForMoc(
  mocSlug: string,
  wikiPages: Array<Pick<GraphWikiPage, "path" | "title" | "summary" | "sourceIds">>,
  assignments: Map<string, GraphAssignment>,
): Array<Pick<GraphWikiPage, "path" | "title" | "summary" | "sourceIds">> {
  return wikiPages.filter((wiki) => {
    const counts = new Map<string, number>();
    for (const sourceId of wiki.sourceIds) {
      const primary = assignments.get(sourceId)?.primaryMoc;
      if (primary) counts.set(primary, (counts.get(primary) ?? 0) + 1);
    }
    const winner = [...counts.entries()].sort((left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0])
    )[0]?.[0];
    return winner === mocSlug;
  });
}

function renderMoc(
  definition: MocDefinition,
  node: RenderedMocNode,
  children: RenderedMocNode[],
  wikiPages: Array<Pick<GraphWikiPage, "path" | "title" | "summary" | "sourceIds">>,
): RenderedGraphPage {
  const lines = [`# ${node.title}`, ""];
  if (node.parentSlug) {
    lines.push(`Part of ${link(`MOCs/${definition.title}.md`, definition.title)}.`, "");
  } else {
    lines.push(definition.description, "");
  }
  if (children.length) {
    lines.push("## Collections", "", ...children.map((child) => `- ${link(child.path, child.title)}`), "");
  }
  if (wikiPages.length) {
    lines.push("## Syntheses", "", ...wikiPages.map((wiki) => `- ${link(wiki.path, wiki.title)} — ${wiki.summary}`), "");
  }
  if (node.sources.length) {
    lines.push("## Notes", "", ...node.sources.map((source) => `- ${link(source.path, source.title)}`), "");
  }
  if (!children.length && !wikiPages.length && !node.sources.length) {
    lines.push("_No notes have been assigned here yet._", "");
  }
  return {
    path: node.path,
    content: page({
      ckb_id: `page:moc:${node.slug}`,
      title: node.title,
      type: "moc",
      domain: definition.domainSlug,
    }, lines.join("\n")),
  };
}

export function renderKnowledgeGraph(input: RenderKnowledgeGraphInput): RenderKnowledgeGraphResult {
  const assignments = new Map(input.assignments.map((assignment) => [assignment.sourceId, assignment]));
  const sourcesById = new Map(input.sources.map((source) => [source.sourceId, source]));
  const pages: RenderedGraphPage[] = [];

  const homeLines = [
    "# Personal Knowledge Base",
    "",
    "A map for revisiting ideas, noticing connections, and turning accumulated notes into decisions and new work.",
    "",
    "## Domains",
    "",
    ...input.taxonomy.domains.map((domain) => `- ${link(`Domains/${domain.title}.md`, domain.title)} — ${domain.description}`),
  ];
  if (input.wikiPages.length > 0) {
    homeLines.push(
      "",
      "## Syntheses",
      "",
      ...[...input.wikiPages]
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((wiki) => `- ${link(wiki.path, wiki.title)} — ${wiki.summary}`),
    );
  }
  homeLines.push("", "## Browse", "", "- [Browse all notes](Views/All%20Notes.base)");
  pages.push({
    path: "Home.md",
    content: page(
      { ckb_id: "page:home", title: "Personal Knowledge Base", type: "home" },
      homeLines.join("\n"),
    ),
  });

  const allMocNodes = new Map<string, RenderedMocNode[]>();
  const parentPathByMembership = new Map<string, string>();
  for (const definition of input.taxonomy.mocs) {
    const members = sourceMembership(definition.slug, input.sources, assignments);
    const nodes = buildMocNodes(definition, members, input.mocDirectChildLimit);
    allMocNodes.set(definition.slug, nodes);
    const collections = nodes.slice(1);
    for (const member of members) {
      const containing = collections.find((collection) => collection.sources.some((source) => source.sourceId === member.sourceId)) ?? nodes[0]!;
      parentPathByMembership.set(`${definition.slug}\u0000${member.sourceId}`, containing.path);
    }
  }

  for (const domain of input.taxonomy.domains) {
    const domainMocs = input.taxonomy.mocs.filter((moc) => moc.domainSlug === domain.slug);
    pages.push({
      path: `Domains/${domain.title}.md`,
      content: page({ ckb_id: `page:domain:${domain.slug}`, title: domain.title, type: "domain" }, [
        `# ${domain.title}`,
        "",
        domain.description,
        "",
        "## Maps of content",
        "",
        ...domainMocs.map((moc) => `- ${link(`MOCs/${moc.title}.md`, moc.title)} — ${moc.description}`),
      ].join("\n")),
    });
  }

  for (const definition of input.taxonomy.mocs) {
    const nodes = allMocNodes.get(definition.slug)!;
    pages.push(renderMoc(
      definition,
      nodes[0]!,
      nodes.slice(1),
      wikiForMoc(definition.slug, input.wikiPages, assignments),
    ));
    for (const collection of nodes.slice(1)) {
      pages.push(renderMoc(definition, collection, [], []));
    }
  }

  const sourceConnections: RenderedSourceConnections[] = input.sources.map((source) => {
    const assignment = assignments.get(source.sourceId);
    const primaryAndSecondary = assignment
      ? [assignment.primaryMoc, ...assignment.secondaryMocs]
      : [];
    const parents = primaryAndSecondary.map((mocSlug) => {
      const path = parentPathByMembership.get(`${mocSlug}\u0000${source.sourceId}`);
      const title = allMocNodes.get(mocSlug)?.find((node) => node.path === path)?.title;
      return path && title ? { path, title } : null;
    }).filter((value): value is { path: string; title: string } => value !== null);
    const childParents = input.relationships
      .filter((edge) => edge.kind === "child" && edge.toId === source.sourceId && !edge.rejected)
      .map((edge) => sourcesById.get(edge.fromId)).filter((value): value is SourceState => value !== undefined);
    const children = input.relationships
      .filter((edge) => edge.kind === "child" && edge.fromId === source.sourceId && !edge.rejected)
      .map((edge) => sourcesById.get(edge.toId)).filter((value): value is SourceState => value !== undefined);
    const relatedEdges = input.relationships.filter((edge) =>
      edge.kind === "related" && !edge.rejected && (edge.fromId === source.sourceId || edge.toId === source.sourceId)
    );
    const related = relatedEdges
      .map((edge) => sourcesById.get(edge.fromId === source.sourceId ? edge.toId : edge.fromId))
      .filter((value): value is SourceState => value !== undefined);
    const lines = ["## Connections", ""];
    if (parents[0]) lines.push(`- Parent: ${link(parents[0].path, parents[0].title)}`);
    if (parents.length > 1) lines.push(`- Also in: ${parents.slice(1).map((parent) => link(parent.path, parent.title)).join(", ")}`);
    if (childParents.length) lines.push(`- Parent notes: ${childParents.map((parent) => link(parent.path, parent.title)).sort().join(", ")}`);
    if (children.length) lines.push(`- Children: ${children.map((child) => link(child.path, child.title)).sort().join(", ")}`);
    if (related.length) lines.push(`- Related: ${[...new Set(related.map((item) => link(item.path, item.title)))].sort().join(", ")}`);
    const rationales = relatedEdges.filter((edge) => edge.rationale).map((edge) => {
      const target = sourcesById.get(edge.fromId === source.sourceId ? edge.toId : edge.fromId);
      return target ? `- ${link(target.path, target.title)}: ${edge.rationale}` : null;
    }).filter((value): value is string => value !== null);
    if (rationales.length) lines.push("", "### Why these are related", "", ...rationales);
    return {
      sourceId: source.sourceId,
      content: `${lines.join("\n")}\n`,
      parentMocPaths: parents.map((parent) => parent.path),
    };
  });

  return { pages, sourceConnections };
}
