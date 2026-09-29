import { diff3Merge } from "node-diff3";

export interface MergeConflict {
  base: string[];
  human: string[];
  proposed: string[];
}

export type MergeResult =
  | { kind: "merged"; content: string }
  | { kind: "conflict"; conflicts: MergeConflict[] };

interface Diff3Block {
  ok?: string[];
  conflict?: {
    o: string[];
    a: string[];
    b: string[];
  };
}

function lineTokens(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function refineAlignedConflict(conflict: MergeConflict): string[] | undefined {
  if (
    conflict.base.length !== conflict.human.length ||
    conflict.base.length !== conflict.proposed.length
  ) {
    return undefined;
  }

  const resolved: string[] = [];
  for (let index = 0; index < conflict.base.length; index += 1) {
    const base = conflict.base[index];
    const human = conflict.human[index];
    const proposed = conflict.proposed[index];
    if (human === proposed) resolved.push(human ?? "");
    else if (human === base) resolved.push(proposed ?? "");
    else if (proposed === base) resolved.push(human ?? "");
    else return undefined;
  }
  return resolved;
}

export function mergeMarkdown(base: string, human: string, proposed: string): MergeResult {
  const blocks = diff3Merge(
    lineTokens(human),
    lineTokens(base),
    lineTokens(proposed),
    { excludeFalseConflicts: true },
  ) as Diff3Block[];
  const merged: string[] = [];
  const conflicts: MergeConflict[] = [];

  for (const block of blocks) {
    if (block.ok) merged.push(...block.ok);
    if (block.conflict) {
      const conflict = {
        base: block.conflict.o,
        human: block.conflict.a,
        proposed: block.conflict.b,
      };
      const refined = refineAlignedConflict(conflict);
      if (refined) merged.push(...refined);
      else conflicts.push(conflict);
    }
  }

  return conflicts.length > 0
    ? { kind: "conflict", conflicts }
    : { kind: "merged", content: merged.join("") };
}
