import { sha256 } from "../core/hash.js";
import type { RelationshipState } from "../state/types.js";

export function relationshipId(input: Pick<RelationshipState, "fromId" | "toId" | "kind" | "origin">): string {
  return `rel:${sha256([input.fromId, input.toId, input.kind, input.origin].join("\u0000"))}`;
}

export function createRelationship(
  input: Omit<RelationshipState, "relationshipId" | "rejected"> & { rejected?: boolean },
): RelationshipState {
  return {
    ...input,
    relationshipId: relationshipId(input),
    rejected: input.rejected ?? false,
  };
}
