import { z } from "zod";

const SourceIdSchema = z.string().regex(/^apple-note:[0-9a-f]{64}$/);

export const GraphAssignmentSchema = z.object({
  sourceId: SourceIdSchema,
  primaryMoc: z.string().min(1),
  secondaryMocs: z.array(z.string().min(1)).default([]),
}).strict();

export const InferredRelationshipSchema = z.object({
  fromSourceId: SourceIdSchema,
  toSourceId: SourceIdSchema,
  rationale: z.string().trim().min(12),
  confidence: z.number().min(0).max(1),
}).strict();

export const GraphWikiPageSchema = z.object({
  path: z.string().startsWith("Wiki/").endsWith(".md"),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  body: z.string().trim().min(1),
  sourceIds: z.array(SourceIdSchema).min(1, "Wiki source provenance is required"),
}).strict();

export const ProposedMocSchema = z.object({
  title: z.string().trim().min(1),
  domainSlug: z.string().min(1),
  rationale: z.string().trim().min(12),
  sourceIds: z.array(SourceIdSchema).min(1),
}).strict();

export const GraphPlanSchema = z.object({
  schemaVersion: z.literal(1),
  assignments: z.array(GraphAssignmentSchema),
  inferredRelationships: z.array(InferredRelationshipSchema),
  wikiPages: z.array(GraphWikiPageSchema),
  proposedMocs: z.array(ProposedMocSchema),
}).strict();

export type GraphPlan = z.infer<typeof GraphPlanSchema>;
export type GraphAssignment = z.infer<typeof GraphAssignmentSchema>;
export type GraphWikiPage = z.infer<typeof GraphWikiPageSchema>;
