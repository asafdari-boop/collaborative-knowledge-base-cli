import type { IncrementalCompilerManifest } from "./incremental-manifest.js";

export const CODEX_RUN_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "compiled", "skipped", "deleted", "warnings"],
  properties: {
    status: { type: "string", enum: ["complete"] },
    compiled: { type: "integer", minimum: 0 },
    skipped: { type: "integer", minimum: 0 },
    deleted: { type: "integer", minimum: 0 },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const;

function selection(manifest: IncrementalCompilerManifest): string {
  if (manifest.rebuild) {
    return `This is a complete rebuild (${manifest.rebuildReason}). Read every Markdown file in sources/ and inspect every existing page in wiki/.`;
  }
  return [
    "This is an incremental refresh. Do not semantically re-analyze unchanged sources outside the affected set.",
    `New sources: ${manifest.newSources.join(", ") || "none"}`,
    `Changed sources: ${manifest.changedSources.join(", ") || "none"}`,
    `Missing sources: ${manifest.missingSources.join(", ") || "none"}`,
    `Affected pages: ${manifest.affectedPages.join(", ") || "none"}`,
    "Read the new/changed source files, affected pages, their directly linked neighbors, and affected Maps of Content. Preserve unrelated pages byte-for-byte.",
  ].join("\n");
}

export function codexKnowledgeInstructions(manifest: IncrementalCompilerManifest): string {
  return `# CKB knowledge compiler

You are operating inside a disposable staging project. You may read only this project and may write only .ckb-output/graph-plan.json plus the structured run report requested by the CLI. Never read parent paths, the user's home directory, Apple Notes, credentials, or the live vault. Do not use the network.

${selection(manifest)}

## Inputs

- sources/ contains complete, locally normalized and screened first-class Apple Notes with readable filenames.
- source-catalog.json maps each staged filename to its stable source ID, readable title, and final vault path.
- taxonomy.json is the authoritative domain and MOC hierarchy.
- graph-state.json contains existing assignments and relationships that must be preserved outside the requested incremental scope.
- wiki/ is a point-in-time snapshot of existing synthesis pages for context; do not write to it.
- incremental-manifest.json is authoritative for hashes and incremental scope.
- graph-plan.schema.json is the exact JSON schema for .ckb-output/graph-plan.json.

## Required output

Produce .ckb-output/graph-plan.json matching graph-plan.schema.json. CKB will validate stable IDs, enforce limits, turn IDs into readable Obsidian links, and render the vault.

Classify every source during a rebuild. Assign one primary MOC and only genuinely useful secondary MOCs. Prefer a sparse, legible graph: at most five high-confidence inferred relationships from any source, each with a concrete rationale. Do not repeat explicit links already visible in source pages. A relationship should help a person discover an idea they would otherwise miss, not merely reflect shared vocabulary.

Create compressed Wiki syntheses only when several notes combine into a durable idea, decision framework, useful overview, or genuine tension. Do not create one Wiki page per source, a giant source index, or an exhaustive Home page. The Notes layer already preserves every source.

Each useful Wiki body should, when supported by evidence, include:

- Core ideas
- Tensions and contradictions
- Questions for reflection
- Ideas worth developing
- Related notes

Write specific synthesis, not generic summaries. Preserve uncertainty and clearly label deductions that are your inference rather than statements in the notes. Every Wiki page must list all supporting stable source IDs in sourceIds. CKB will append readable source links. Never emit ^[apple-note-...] citations or hash filenames.

If the taxonomy genuinely cannot express an important recurring cluster, add a proposedMocs entry. This creates a human review; it does not alter the taxonomy automatically.

Do not alter sources/, wiki/, source-catalog.json, taxonomy.json, graph-state.json, incremental-manifest.json, CKB_INSTRUCTIONS.md, or either schema file. Finish only after validating graph-plan.json against graph-plan.schema.json and accounting for the complete requested scope.
`;
}
