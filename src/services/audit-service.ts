import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CkbConfig } from "../config/schema.js";
import type { NotesExtractor } from "../extractors/types.js";
import { planSourceMirrorRefresh } from "../normalization/source-plan.js";
import { parsePage } from "../pages/frontmatter.js";

export interface LocalAuditServiceDependencies {
  extractor: NotesExtractor;
}

export interface LocalAuditOptions {
  vault: string;
  config: CkbConfig;
  signal?: AbortSignal;
}

export interface LocalAuditResult {
  noteCount: number;
  compilerEligible: number;
  excluded: number;
  inaccessible: number;
  truncated: number;
  redactions: number;
  attachmentFilesPlanned: number;
  riskCategories: Record<string, number>;
  warnings: { code: string; message: string }[];
  scope: {
    accounts: string[];
    folders: string[];
    allowlistedNoteCount: number;
    maximumNoteCount: number;
  };
}

const TITLE_RISK_PATTERNS: Record<string, RegExp> = {
  credentials: /password|passphrase|credential|api[ _-]?key|secret|token/i,
  health: /health|medical|doctor|hospital|surgery|medication|therapy/i,
  financial: /bank|tax|investment|portfolio|financial|credit|debit|wallet/i,
  personal: /journal|diary|my story|relationship|family|private/i,
};

function riskCategoryCounts(titles: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [category, pattern] of Object.entries(TITLE_RISK_PATTERNS)) {
    const count = titles.filter((title) => pattern.test(title)).length;
    if (count > 0) counts[category] = count;
  }
  return counts;
}

export class LocalAuditService {
  public constructor(private readonly dependencies: LocalAuditServiceDependencies) {}

  public async audit(options: LocalAuditOptions): Promise<LocalAuditResult> {
    const stagingDirectory = await mkdtemp(join(tmpdir(), "ckb-audit-"));
    try {
      const extraction = await this.dependencies.extractor.extract({
        stagingDirectory,
        accountAllowlist: options.config.extractor.accountAllowlist,
        folderAllowlist: options.config.extractor.folderAllowlist,
        noteIdAllowlist: options.config.extractor.noteIdAllowlist,
        maximumNoteCount: options.config.extractor.maximumNoteCount,
        timeoutMs: options.config.extractor.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const plan = await planSourceMirrorRefresh({
        vault: options.vault,
        extraction,
        config: options.config,
      });
      const compilerEligible = plan.sources.filter((source) => source.compilerEligible);
      const truncated = compilerEligible.filter((source) =>
        parsePage(source.content).attributes.truncated === true
      ).length;

      return {
        noteCount: extraction.census.coverage.noteCount,
        compilerEligible: compilerEligible.length,
        excluded: plan.result.excluded,
        inaccessible: plan.result.inaccessible,
        truncated,
        redactions: plan.result.redactions,
        attachmentFilesPlanned: plan.result.attachmentFilesCreated,
        riskCategories: riskCategoryCounts(
          extraction.census.notes.map((note) => note.title),
        ),
        warnings: extraction.census.warnings.map(({ code, message }) => ({ code, message })),
        scope: {
          accounts: [...options.config.extractor.accountAllowlist],
          folders: [...options.config.extractor.folderAllowlist],
          allowlistedNoteCount: options.config.extractor.noteIdAllowlist.length,
          maximumNoteCount: options.config.extractor.maximumNoteCount,
        },
      };
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}
