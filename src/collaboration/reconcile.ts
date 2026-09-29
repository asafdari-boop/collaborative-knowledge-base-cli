import { sha256 } from "../core/hash.js";
import { mergeMarkdown, type MergeConflict } from "./merge.js";

export interface ReconcileInput {
  base: string;
  live: string;
  proposed: string;
  expectedHash: string;
  directPatch?: boolean;
}

export type ReconcileResult =
  | { kind: "apply"; content: string; mode: "clean" | "merged" }
  | { kind: "conflict"; conflicts: MergeConflict[] }
  | { kind: "stale_revision"; expectedHash: string; actualHash: string }
  | { kind: "noop" };

export function reconcilePage(input: ReconcileInput): ReconcileResult {
  const directPatch = input.directPatch === true;
  const actualHash = sha256(directPatch ? input.live : input.base);
  if (input.expectedHash !== actualHash) {
    return {
      kind: "stale_revision",
      expectedHash: input.expectedHash,
      actualHash,
    };
  }

  if (input.live === input.proposed) return { kind: "noop" };
  if (directPatch) {
    return { kind: "apply", content: input.proposed, mode: "clean" };
  }
  if (input.live === input.base) {
    return { kind: "apply", content: input.proposed, mode: "clean" };
  }

  const merged = mergeMarkdown(input.base, input.live, input.proposed);
  if (merged.kind === "conflict") return merged;
  if (merged.content === input.live) return { kind: "noop" };
  return { kind: "apply", content: merged.content, mode: "merged" };
}
