import { posix } from "node:path";
import { CompilerValidationError } from "../core/errors.js";
import { GraphPlanSchema, type GraphPlan } from "./graph-schema.js";

export interface GraphPlanValidationContext {
  sourceIds: ReadonlySet<string>;
  mocSlugs: ReadonlySet<string>;
  domainSlugs: ReadonlySet<string>;
  inferenceCapPerNote: number;
  rebuild: boolean;
  affectedSourceIds: ReadonlySet<string>;
}

function fail(message: string): never {
  throw new CompilerValidationError(message);
}

function assertKnownSource(sourceId: string, context: GraphPlanValidationContext, label: string): void {
  if (!context.sourceIds.has(sourceId)) fail(`${label} references unknown source ${sourceId}`);
}

function safeWikiPath(path: string): boolean {
  return path.startsWith("Wiki/") &&
    path.endsWith(".md") &&
    !path.includes("\\") &&
    !path.split("/").includes("..") &&
    posix.normalize(path) === path;
}

export function validateGraphPlan(raw: unknown, context: GraphPlanValidationContext): GraphPlan {
  const parsed = GraphPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CompilerValidationError(`Malformed graph plan: ${parsed.error.message}`);
  }
  const plan = parsed.data;
  const assignments = new Set<string>();
  for (const assignment of plan.assignments) {
    assertKnownSource(assignment.sourceId, context, "Assignment");
    if (assignments.has(assignment.sourceId)) {
      fail(`Graph plan contains a duplicate assignment for ${assignment.sourceId}`);
    }
    assignments.add(assignment.sourceId);
    if (!context.mocSlugs.has(assignment.primaryMoc)) {
      fail(`Assignment uses unknown MOC ${assignment.primaryMoc}`);
    }
    for (const moc of assignment.secondaryMocs) {
      if (!context.mocSlugs.has(moc)) fail(`Assignment uses unknown MOC ${moc}`);
    }
    if (!context.rebuild && !context.affectedSourceIds.has(assignment.sourceId)) {
      fail(`Incremental graph plan attempted to assign unaffected source ${assignment.sourceId}`);
    }
  }
  if (context.rebuild) {
    const omitted = [...context.sourceIds].filter((sourceId) => !assignments.has(sourceId));
    if (omitted.length) fail(`Graph plan omitted ${omitted.length} source assignment${omitted.length === 1 ? "" : "s"}`);
  }

  const relationshipKeys = new Set<string>();
  const inferenceCounts = new Map<string, number>();
  for (const relationship of plan.inferredRelationships) {
    assertKnownSource(relationship.fromSourceId, context, "Inferred relationship");
    assertKnownSource(relationship.toSourceId, context, "Inferred relationship");
    if (relationship.fromSourceId === relationship.toSourceId) {
      fail("Graph plan contains an inferred self-relationship");
    }
    const key = `${relationship.fromSourceId}\u0000${relationship.toSourceId}`;
    if (relationshipKeys.has(key)) fail("Graph plan contains a duplicate inferred relationship");
    relationshipKeys.add(key);
    const nextCount = (inferenceCounts.get(relationship.fromSourceId) ?? 0) + 1;
    inferenceCounts.set(relationship.fromSourceId, nextCount);
    if (nextCount > context.inferenceCapPerNote) {
      fail(`Graph plan exceeds the inference cap for ${relationship.fromSourceId}`);
    }
  }

  const wikiPaths = new Set<string>();
  for (const page of plan.wikiPages) {
    if (!safeWikiPath(page.path)) fail(`Graph plan contains an unsafe Wiki path ${page.path}`);
    if (wikiPaths.has(page.path)) fail(`Graph plan contains duplicate Wiki path ${page.path}`);
    wikiPaths.add(page.path);
    if (page.sourceIds.length === 0) fail(`Wiki page ${page.path} has no source provenance`);
    for (const sourceId of page.sourceIds) assertKnownSource(sourceId, context, `Wiki page ${page.path}`);
    if (/\^\[apple-note-/i.test(page.body)) {
      fail(`Wiki page ${page.path} uses a legacy hash citation`);
    }
  }
  for (const proposal of plan.proposedMocs) {
    if (!context.domainSlugs.has(proposal.domainSlug)) {
      fail(`Proposed MOC uses unknown domain ${proposal.domainSlug}`);
    }
    for (const sourceId of proposal.sourceIds) assertKnownSource(sourceId, context, "Proposed MOC");
  }
  return plan;
}
