import { describe, expect, it } from "vitest";
import { validateGraphPlan } from "../../src/index.js";

const sourceA = `apple-note:${"a".repeat(64)}`;
const sourceB = `apple-note:${"b".repeat(64)}`;

function plan() {
  return {
    schemaVersion: 1 as const,
    assignments: [
      { sourceId: sourceA, primaryMoc: "investments", secondaryMocs: [] },
      { sourceId: sourceB, primaryMoc: "companies-and-institutions", secondaryMocs: ["investments"] },
    ],
    inferredRelationships: [{
      fromSourceId: sourceA,
      toSourceId: sourceB,
      rationale: "The investment thesis evaluates this company's durability.",
      confidence: 0.88,
    }],
    wikiPages: [{
      path: "Wiki/Investment Principles.md",
      title: "Investment Principles",
      summary: "Durable principles and unresolved tensions.",
      body: "# Investment Principles\n\n## Core ideas\n\nPrefer understandable durability.\n\n## Questions for reflection\n\nWhat would change this view?\n",
      sourceIds: [sourceA, sourceB],
    }],
    proposedMocs: [],
  };
}

describe("Codex graph-plan validation", () => {
  const context = {
    sourceIds: new Set([sourceA, sourceB]),
    mocSlugs: new Set(["investments", "companies-and-institutions"]),
    domainSlugs: new Set(["business-and-money"]),
    inferenceCapPerNote: 5,
    rebuild: true,
    affectedSourceIds: new Set([sourceA, sourceB]),
  };

  it("accepts complete, grounded, bounded plans", () => {
    expect(validateGraphPlan(plan(), context).assignments).toHaveLength(2);
  });

  it("requires exactly one assignment for every source on rebuild", () => {
    const incomplete = plan();
    incomplete.assignments.pop();
    expect(() => validateGraphPlan(incomplete, context)).toThrow(/omitted.*source/i);
    const duplicate = plan();
    duplicate.assignments.push(duplicate.assignments[0]!);
    expect(() => validateGraphPlan(duplicate, context)).toThrow(/duplicate.*assignment/i);
  });

  it("rejects unknown IDs, MOCs, self-edges, duplicates, and per-note edge overflow", () => {
    const unknown = plan();
    unknown.assignments[0]!.primaryMoc = "unknown";
    expect(() => validateGraphPlan(unknown, context)).toThrow(/unknown MOC/i);

    const self = plan();
    self.inferredRelationships[0]!.toSourceId = sourceA;
    expect(() => validateGraphPlan(self, context)).toThrow(/self/i);

    const duplicate = plan();
    duplicate.inferredRelationships.push({ ...duplicate.inferredRelationships[0]! });
    expect(() => validateGraphPlan(duplicate, context)).toThrow(/duplicate.*relationship/i);

    const overflow = plan();
    expect(() => validateGraphPlan(overflow, { ...context, inferenceCapPerNote: 0 }))
      .toThrow(/inference cap/i);
  });

  it("rejects ungrounded or unsafe Wiki synthesis", () => {
    const ungrounded = plan();
    ungrounded.wikiPages[0]!.sourceIds = [];
    expect(() => validateGraphPlan(ungrounded, context)).toThrow(/provenance/i);

    const unsafe = plan();
    unsafe.wikiPages[0]!.path = "Wiki/../escape.md";
    expect(() => validateGraphPlan(unsafe, context)).toThrow(/unsafe/i);

    const legacy = plan();
    legacy.wikiPages[0]!.body += "^[apple-note-deadbeef.md]";
    expect(() => validateGraphPlan(legacy, context)).toThrow(/legacy/i);
  });

  it("confines incremental assignments to affected sources", () => {
    expect(() => validateGraphPlan(plan(), {
      ...context,
      rebuild: false,
      affectedSourceIds: new Set([sourceA]),
    })).toThrow(/unaffected source/i);
  });
});
