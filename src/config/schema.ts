import { z } from "zod";
import { isAbsolute } from "node:path";

const UniqueNoteIdsSchema = z.array(z.string().min(1)).refine(
  (ids) => new Set(ids).size === ids.length,
  "Duplicate note IDs are not allowed",
);

const ExtractorConfigSchema = z
  .object({
    executable: z.string().min(1).default("notes-export"),
    databasePath: z
      .string()
      .min(1)
      .refine(isAbsolute, "Expected an absolute database path")
      .optional(),
    accountAllowlist: z.array(z.string().min(1)).default([]),
    folderAllowlist: z.array(z.string().min(1)).default([]),
    noteIdAllowlist: UniqueNoteIdsSchema.default([]),
    maximumNoteCount: z.number().int().positive().default(20),
    timeoutMs: z.number().int().positive().max(60 * 60 * 1000).default(300_000),
  })
  .default({
    executable: "notes-export",
    accountAllowlist: [],
    folderAllowlist: [],
    noteIdAllowlist: [],
    maximumNoteCount: 20,
    timeoutMs: 300_000,
  });

const LlmwikiProviderSchema = z.enum([
  "environment",
  "anthropic",
  "claude-agent",
  "openai",
  "ollama",
  "minimax",
  "copilot",
]);

const LlmwikiCompilerSchema = z.object({
  adapter: z.literal("llmwiki"),
  provider: LlmwikiProviderSchema.default("environment"),
}).strict();

const CodexCompilerSchema = z.object({
  adapter: z.literal("codex-agent"),
  executable: z.string().min(1).refine(isAbsolute, "Expected an absolute Codex executable path"),
  model: z.string().min(1),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
}).strict();

const NormalizedCompilerConfigSchema = z.object({
  primary: z.discriminatedUnion("adapter", [CodexCompilerSchema, LlmwikiCompilerSchema]),
  fallback: LlmwikiCompilerSchema.nullable().default(null),
  fallbackPolicy: z.literal("manual").default("manual"),
  concurrency: z.number().int().min(1).max(16).default(3),
}).strict();

const LegacyCompilerConfigSchema = z.object({
  adapter: z.literal("llmwiki").default("llmwiki"),
  concurrency: z.number().int().min(1).max(16).default(3),
  provider: LlmwikiProviderSchema.default("environment"),
}).strict();

const CompilerConfigSchema = z
  .union([NormalizedCompilerConfigSchema, LegacyCompilerConfigSchema])
  .default({ adapter: "llmwiki", concurrency: 3, provider: "environment" })
  .transform((compiler) => "primary" in compiler
    ? compiler
    : {
        primary: { adapter: "llmwiki" as const, provider: compiler.provider },
        fallback: null,
        fallbackPolicy: "manual" as const,
        concurrency: compiler.concurrency,
      });

const SensitivityConfigSchema = z
  .object({
    excludedNoteIds: z.array(z.string().min(1)).default([]),
    excludedTitlePatterns: z.array(z.string().min(1)).default([]),
    redactSecrets: z.boolean().default(true),
  })
  .default({
    excludedNoteIds: [],
    excludedTitlePatterns: [],
    redactSecrets: true,
  });

const GraphConfigSchema = z
  .object({
    taxonomyVersion: z.number().int().positive().default(1),
    pathPolicyVersion: z.number().int().positive().default(1),
    inferenceCapPerNote: z.number().int().min(0).max(20).default(5),
    mocDirectChildLimit: z.number().int().positive().max(200).default(50),
    missingNoteRetention: z.literal("retain").default("retain"),
    graphExclusions: z.array(z.string().min(1)).default([
      "Attachments",
      "Reviews",
      "System",
      ".ckb",
    ]),
  })
  .default({
    taxonomyVersion: 1,
    pathPolicyVersion: 1,
    inferenceCapPerNote: 5,
    mocDirectChildLimit: 50,
    missingNoteRetention: "retain",
    graphExclusions: ["Attachments", "Reviews", "System", ".ckb"],
  });

export const CkbConfigSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).transform(() => 2 as const),
  vaultPath: z.string().min(1),
  extractor: ExtractorConfigSchema,
  compiler: CompilerConfigSchema,
  sensitivity: SensitivityConfigSchema,
  graph: GraphConfigSchema,
  attachmentMaxBytes: z.number().int().positive().default(100 * 1024 * 1024),
  tombstoneRetentionDays: z.number().int().positive().default(90),
  gitCheckpoint: z.boolean().default(false),
});

export type CkbConfig = z.infer<typeof CkbConfigSchema>;
