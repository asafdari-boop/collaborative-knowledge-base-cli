import { access, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { CkbConfig } from "../config/schema.js";
import { LLMWIKI_VERSION } from "../compiler/llmwiki-adapter.js";
import { listReviews } from "../reviews/review-store.js";
import { loadState } from "../state/state-store.js";
import { listRecoveryRecords } from "../publishing/recovery-store.js";
import { calculateGraphMetrics } from "../graph/metrics.js";
import type { RenderedGraphPage } from "../graph/render.js";

export interface StatusServiceDependencies {
  env?: NodeJS.ProcessEnv;
}

export interface StatusOptions {
  vault: string;
  config: CkbConfig;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function providerStatus(config: CkbConfig, env: NodeJS.ProcessEnv) {
  const compiler = config.compiler.primary;
  if (compiler.adapter === "codex-agent") {
    return { name: "chatgpt-login", credentialsPresent: null };
  }
  const name = compiler.provider === "environment"
    ? env.LLMWIKI_PROVIDER?.trim().toLowerCase() || "anthropic"
    : compiler.provider;
  const keyNames = name === "anthropic"
    ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    : name === "openai"
      ? ["OPENAI_API_KEY"]
      : name === "copilot"
        ? ["GITHUB_TOKEN"]
      : name === "ollama" || name === "claude-agent"
        ? []
        : [`${name.toUpperCase()}_API_KEY`];
  return {
    name,
    credentialsPresent:
      name === "ollama" || name === "claude-agent" ||
      keyNames.some((key) => Boolean(env[key]?.trim())),
  };
}

async function liveGraphPages(vault: string): Promise<RenderedGraphPage[]> {
  const pages: RenderedGraphPage[] = [];
  const home = join(vault, "Home.md");
  if (await exists(home)) pages.push({ path: "Home.md", content: await readFile(home, "utf8") });
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        pages.push({
          path: relative(vault, absolute).split(sep).join("/"),
          content: await readFile(absolute, "utf8"),
        });
      }
    }
  };
  for (const directory of ["Domains", "MOCs", "Notes", "Wiki"]) {
    await visit(join(vault, directory));
  }
  return pages.sort((left, right) => left.path.localeCompare(right.path));
}

async function visiblePendingReviewPaths(vault: string): Promise<string[]> {
  const root = join(vault, "Reviews");
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await readFile(absolute, "utf8");
        if (/^status:\s*pending\s*$/m.test(content)) {
          paths.push(relative(vault, absolute).split(sep).join("/"));
        }
      }
    }
  };
  await visit(root);
  return paths;
}

export class StatusService {
  private readonly env: NodeJS.ProcessEnv;

  public constructor(dependencies: StatusServiceDependencies = {}) {
    this.env = dependencies.env ?? process.env;
  }

  public async read(options: StatusOptions) {
    const state = await loadState(options.vault);
    const reviews = await listReviews(options.vault);
    const sourceStatuses = {
      present: 0,
      inaccessible: 0,
      excluded: 0,
      missingUpstream: 0,
    };
    for (const source of Object.values(state.sources)) {
      if (source.censusStatus === "missing_upstream") sourceStatuses.missingUpstream += 1;
      else sourceStatuses[source.censusStatus] += 1;
    }
    const sources = Object.values(state.sources);
    const relationships = Object.values(state.relationships);
    const relationshipsByOrigin: Record<string, number> = {};
    for (const relationship of relationships.filter((relationship) => !relationship.rejected)) {
      relationshipsByOrigin[relationship.origin] = (relationshipsByOrigin[relationship.origin] ?? 0) + 1;
    }
    const syncStatuses = {
      clean: sources.filter((source) => source.syncStatus === "clean").length,
      localDivergence: sources.filter((source) => source.syncStatus === "local_divergence").length,
      conflict: sources.filter((source) => source.syncStatus === "conflict").length,
      missingUpstream: sources.filter((source) => source.syncStatus === "missing_upstream").length,
    };
    const graphPages = await liveGraphPages(options.vault);
    const eligibleSourcePaths = new Set(sources
      .filter((source) => source.censusStatus === "present")
      .map((source) => source.path));
    const eligibleGraphPages = graphPages.filter((page) =>
      !page.path.startsWith("Notes/") || eligibleSourcePaths.has(page.path));
    const visibleReviews = await visiblePendingReviewPaths(options.vault);
    const pendingReviewPaths = new Set([
      ...reviews.map((review) => review.visiblePath),
      ...visibleReviews,
    ]);
    return {
      workspace: {
        pages: Object.keys(state.pages).length,
        sources: Object.keys(state.sources).length,
        sourceStatuses,
        pendingReviews: pendingReviewPaths.size,
        locked: await exists(join(options.vault, ".ckb/lock")),
        recoveryRecords: (await listRecoveryRecords(options.vault)).length,
      },
      extraction: state.pipeline?.lastExtraction ?? null,
      compilation: state.pipeline?.lastCompilation ?? null,
      lastSuccessfulRefreshAt: state.pipeline?.lastSuccessfulRefreshAt ?? null,
      graph: {
        readableSources: sources.filter((source) => source.path.startsWith("Notes/")).length,
        protectedSources: sources.filter((source) => source.censusStatus !== "present").length,
        assignedSources: sources.filter((source) => source.censusStatus === "present" && source.primaryMoc).length,
        unresolvedExplicitReferences: Object.keys(state.unresolvedReferences).length,
        syncStatuses,
        relationshipsByOrigin,
        rejectedRelationships: relationships.filter((relationship) => relationship.rejected).length,
        metrics: calculateGraphMetrics(eligibleGraphPages),
      },
      dependencies: {
        appleNotesExporter: {
          executable: options.config.extractor.executable,
          probed: false,
          note: "Run ckb doctor to test access; status never reads Apple Notes.",
        },
        compiler: {
          adapter: options.config.compiler.primary.adapter,
          ...(options.config.compiler.primary.adapter === "codex-agent"
            ? {
                executable: options.config.compiler.primary.executable,
                model: options.config.compiler.primary.model,
              }
            : { bundledVersion: LLMWIKI_VERSION }),
          fallback: options.config.compiler.fallback,
          fallbackPolicy: options.config.compiler.fallbackPolicy,
          cachePresent: await exists(join(options.vault, ".ckb/compiler/current/.llmwiki")),
        },
        provider: providerStatus(options.config, this.env),
      },
    };
  }
}
