import type { GraphPlan } from "../compiler/graph-schema.js";
import type { WorkspaceState } from "../state/types.js";
import { createRelationship } from "./relationship.js";

export function applyGraphPlanToState(
  state: WorkspaceState,
  plan: GraphPlan,
  rebuild: boolean,
): WorkspaceState {
  const next = structuredClone(state);
  const sourceById = new Map(Object.values(next.sources).map((source) => [source.sourceId, source]));
  const affected = new Set(plan.assignments.map((assignment) => assignment.sourceId));
  for (const assignment of plan.assignments) {
    const source = sourceById.get(assignment.sourceId);
    if (!source) continue;
    source.primaryMoc = assignment.primaryMoc;
    source.secondaryMocs = [...new Set(assignment.secondaryMocs)].sort();
  }

  const retainedRelationships = Object.values(next.relationships).filter((relationship) =>
    relationship.origin !== "inferred" ||
    relationship.rejected ||
    (!rebuild && !affected.has(relationship.fromId))
  );
  const rejected = new Set(
    retainedRelationships.filter((relationship) => relationship.rejected)
      .map((relationship) => `${relationship.fromId}\u0000${relationship.toId}`),
  );
  for (const relationship of plan.inferredRelationships) {
    if (rejected.has(`${relationship.fromSourceId}\u0000${relationship.toSourceId}`)) continue;
    retainedRelationships.push(createRelationship({
      fromId: relationship.fromSourceId,
      toId: relationship.toSourceId,
      kind: "related",
      origin: "inferred",
      rationale: relationship.rationale,
      confidence: relationship.confidence,
    }));
  }
  next.relationships = Object.fromEntries(
    retainedRelationships.map((relationship) => [relationship.relationshipId, relationship]),
  );

  if (rebuild) next.wikiSynthesis = {};
  for (const page of plan.wikiPages) {
    next.wikiSynthesis[page.path] = {
      path: page.path,
      title: page.title,
      summary: page.summary,
      sourceIds: page.sourceIds,
    };
  }
  return next;
}
