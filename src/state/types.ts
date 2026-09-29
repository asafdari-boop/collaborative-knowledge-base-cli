import { z } from "zod";

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const TimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "Expected an ISO-compatible timestamp",
});

export const PageStateSchema = z.object({
  pageId: z.string().startsWith("page:"),
  path: z.string().min(1),
  aliases: z.array(z.string()),
  baseHash: HashSchema.optional(),
  baseObjectHash: HashSchema.optional(),
  sourceHashes: z.array(HashSchema),
  lastOperationId: z.string().startsWith("op:").optional(),
});

export const SourceStateSchema = z.object({
  sourceId: z.string().regex(/^apple-note:[0-9a-f]{64}$/),
  noteIdHash: HashSchema,
  path: z.string().min(1),
  title: z.string(),
  aliases: z.array(z.string()),
  account: z.string(),
  folder: z.string(),
  createdAt: TimestampSchema,
  modifiedAt: TimestampSchema,
  ingestedAt: TimestampSchema.optional(),
  contentHash: HashSchema.optional(),
  generatedHash: HashSchema.optional(),
  attachmentHashes: z.array(HashSchema),
  censusStatus: z.enum(["present", "inaccessible", "excluded", "missing_upstream"]),
  missingCensusCount: z.number().int().nonnegative(),
  lastSeenAt: TimestampSchema.optional(),
  tombstonePath: z.string().min(1).optional(),
  tombstoneObjectHash: HashSchema.optional(),
  lastOperationId: z.string().startsWith("op:").optional(),
  pathHistory: z.array(z.string().min(1)).optional(),
  upstreamHash: HashSchema.optional(),
  upstreamRegionHash: HashSchema.optional(),
  connectionsRegionHash: HashSchema.optional(),
  localRegionHash: HashSchema.optional(),
  primaryMoc: z.string().min(1).optional(),
  secondaryMocs: z.array(z.string().min(1)).optional(),
  syncStatus: z.enum(["clean", "local_divergence", "conflict", "missing_upstream"]).optional(),
});

export const RelationshipStateSchema = z.object({
  relationshipId: z.string().startsWith("rel:"),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  kind: z.enum(["parent", "child", "related", "provenance"]),
  origin: z.enum(["human", "explicit", "structural", "wiki", "inferred"]),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().min(1).optional(),
  rejected: z.boolean().default(false),
});

export const UnresolvedReferenceStateSchema = z.object({
  unresolvedId: z.string().startsWith("unresolved:"),
  sourceId: z.string().startsWith("apple-note:"),
  status: z.enum(["ambiguous", "missing"]),
  label: z.string().min(1),
  candidates: z.array(z.string().startsWith("apple-note:")),
  origin: z.enum(["double-arrow", "apple-link"]),
  reviewPath: z.string().startsWith("Reviews/Links/").endsWith(".md"),
});

export const WikiSynthesisStateSchema = z.object({
  path: z.string().startsWith("Wiki/").endsWith(".md"),
  title: z.string().min(1),
  summary: z.string().min(1),
  sourceIds: z.array(z.string().startsWith("apple-note:")).min(1),
});

const PipelineSchema = z
  .object({
    lastSuccessfulRefreshAt: TimestampSchema,
    lastExtraction: z.object({
      operationId: z.string().startsWith("op:"),
      completedAt: TimestampSchema,
      extractorName: z.string().min(1),
      extractorVersion: z.string().min(1),
      noteCount: z.number().int().nonnegative(),
      warningCount: z.number().int().nonnegative(),
      unsupportedAccounts: z.array(z.string()),
    }),
    lastCompilation: z.object({
      operationId: z.string().startsWith("op:"),
      compilerName: z.string().min(1),
      compilerVersion: z.string().min(1),
      compilerModel: z.string().min(1).optional(),
      compiled: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      deleted: z.number().int().nonnegative(),
      lintWarnings: z.number().int().nonnegative(),
    }),
  })
  .optional();

const WorkspaceStateV1Schema = z.object({
  schemaVersion: z.literal(1),
  pages: z.record(z.string(), PageStateSchema),
  sources: z.record(z.string(), SourceStateSchema).default({}),
  pipeline: PipelineSchema,
});

const WorkspaceStateV2Schema = z.object({
  schemaVersion: z.literal(2),
  pages: z.record(z.string(), PageStateSchema),
  sources: z.record(z.string(), SourceStateSchema).default({}),
  relationships: z.record(z.string(), RelationshipStateSchema).default({}),
  unresolvedReferences: z.record(z.string(), UnresolvedReferenceStateSchema).default({}),
  wikiSynthesis: z.record(z.string(), WikiSynthesisStateSchema).default({}),
  pipeline: PipelineSchema,
});

export const WorkspaceStateSchema = z
  .union([WorkspaceStateV1Schema, WorkspaceStateV2Schema])
  .transform((state) => state.schemaVersion === 2
    ? state
    : {
        ...state,
        schemaVersion: 2 as const,
        relationships: {},
        unresolvedReferences: {},
        wikiSynthesis: {},
      });

export type PageState = z.infer<typeof PageStateSchema>;
export type SourceState = z.infer<typeof SourceStateSchema>;
export type RelationshipState = z.infer<typeof RelationshipStateSchema>;
export type UnresolvedReferenceState = z.infer<typeof UnresolvedReferenceStateSchema>;
export type WikiSynthesisState = z.infer<typeof WikiSynthesisStateSchema>;
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
