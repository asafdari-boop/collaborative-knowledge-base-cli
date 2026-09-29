#!/usr/bin/env node
import { Command } from "commander";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  approveReview,
  AppleNotesExporter,
  CollaborationService,
  CodexCompilerAdapter,
  CompilerValidationError,
  DiffService,
  DoctorService,
  getReview,
  initializeWorkspace,
  listReviews,
  loadWorkspaceConfig,
  LlmwikiCompilerAdapter,
  LocalAuditService,
  PrecomputedGraphCompilerAdapter,
  QueryService,
  RebuildService,
  RefreshService,
  recoverWorkspace,
  rejectReview,
  StatusService,
  UpstreamDiffService,
} from "../index.js";

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function notesExtractor(config: Awaited<ReturnType<typeof loadWorkspaceConfig>>) {
  return new AppleNotesExporter({
    executable: config.extractor.executable,
    ...(config.extractor.databasePath
      ? { databasePath: config.extractor.databasePath }
      : {}),
  });
}

async function refreshService(
  vault: string,
  useFallback = false,
  graphPlanPath?: string,
): Promise<{
  config: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
  service: RefreshService;
}> {
  const config = await loadWorkspaceConfig(vault);
  const compilerConfig = useFallback ? config.compiler.fallback : config.compiler.primary;
  if (!compilerConfig) {
    throw new CompilerValidationError("No manual fallback compiler is configured");
  }
  const compiler = graphPlanPath
    ? new PrecomputedGraphCompilerAdapter(resolve(graphPlanPath))
    : compilerConfig.adapter === "codex-agent"
    ? new CodexCompilerAdapter({
        executable: compilerConfig.executable,
        model: compilerConfig.model,
        reasoningEffort: compilerConfig.reasoningEffort,
      })
    : new LlmwikiCompilerAdapter();
  return {
    config,
    service: new RefreshService({
      extractor: notesExtractor(config),
      compiler,
      compilerConfig,
    }),
  };
}

const program = new Command()
  .name("ckb")
  .description("Collaborative human-agent Markdown knowledge base");

program
  .command("init")
  .requiredOption("--vault <path>")
  .option("--dry-run")
  .action(async (options: { vault: string; dryRun?: boolean }) => {
    print(
      await initializeWorkspace({
        vault: options.vault,
        dryRun: options.dryRun === true,
      }),
    );
  });

program
  .command("audit")
  .description("Run local-only extraction, redaction, and aggregate coverage checks")
  .requiredOption("--vault <path>")
  .action(async (options: { vault: string }) => {
    const config = await loadWorkspaceConfig(options.vault);
    print(
      await new LocalAuditService({ extractor: notesExtractor(config) }).audit({
        vault: options.vault,
        config,
      }),
    );
  });

program
  .command("upstream-diff")
  .description("List upstream Apple Notes changes without invoking a model or writing the vault")
  .requiredOption("--vault <path>")
  .action(async (options: { vault: string }) => {
    const config = await loadWorkspaceConfig(options.vault);
    print(
      await new UpstreamDiffService({ extractor: notesExtractor(config) }).diff({
        vault: options.vault,
        config,
      }),
    );
  });

program
  .command("refresh")
  .requiredOption("--vault <path>")
  .option("--dry-run")
  .option("--use-fallback", "Use only the configured manual fallback compiler")
  .option("--rebuild", "Force a complete compiler rebuild")
  .option("--graph-plan <path>", "Reuse a prior plan after strict full-corpus validation")
  .action(async (options: {
    vault: string;
    dryRun?: boolean;
    useFallback?: boolean;
    rebuild?: boolean;
    graphPlan?: string;
  }) => {
    if (options.graphPlan && options.rebuild !== true) {
      throw new CompilerValidationError("--graph-plan requires --rebuild");
    }
    if (options.graphPlan && options.useFallback === true) {
      throw new CompilerValidationError("--graph-plan cannot be combined with --use-fallback");
    }
    const { config, service } = await refreshService(
      options.vault,
      options.useFallback === true,
      options.graphPlan,
    );
    print(
      await service.refresh({
        vault: options.vault,
        config,
        dryRun: options.dryRun === true,
        rebuild: options.rebuild === true,
      }),
    );
  });

program
  .command("diff")
  .requiredOption("--vault <path>")
  .action(async (options: { vault: string }) => {
    const { config, service } = await refreshService(options.vault);
    print(await new DiffService(service).diff({ vault: options.vault, config }));
  });

program
  .command("recover")
  .description("Roll back an interrupted prepared operation")
  .requiredOption("--vault <path>")
  .action(async (options: { vault: string }) => {
    print(await recoverWorkspace(options.vault));
  });

program
  .command("doctor")
  .description("Check dependencies and workspace health")
  .requiredOption("--vault <path>")
  .option("--no-notes-probe", "Skip the read-only Apple Notes account metadata probe")
  .action(async (options: { vault: string; notesProbe: boolean }) => {
    const config = await loadWorkspaceConfig(options.vault);
    print(
      await new DoctorService().run({
        vault: options.vault,
        config,
        probeNotes: options.notesProbe,
      }),
    );
  });

program
  .command("status")
  .requiredOption("--vault <path>")
  .action(async (options: { vault: string }) => {
    const config = await loadWorkspaceConfig(options.vault);
    print(await new StatusService().read({ vault: options.vault, config }));
  });

program
  .command("query")
  .description("Ask a source-grounded question without allowing vault writes")
  .argument("<question>")
  .requiredOption("--vault <path>")
  .action(async (question: string, options: { vault: string }) => {
    const config = await loadWorkspaceConfig(options.vault);
    if (config.compiler.primary.adapter !== "codex-agent") {
      throw new CompilerValidationError("The primary compiler must be Codex to query the vault");
    }
    const answer = await new QueryService({
      executable: config.compiler.primary.executable,
      model: config.compiler.primary.model,
      reasoningEffort: config.compiler.primary.reasoningEffort,
    }).ask({ vault: options.vault, question });
    process.stdout.write(answer.endsWith("\n") ? answer : `${answer}\n`);
  });

program
  .command("rebuild")
  .description("Build and seal a staging vault, or promote a previously sealed rebuild")
  .requiredOption("--vault <path>", "Current permanent vault")
  .requiredOption("--staging <path>", "Separate staging vault")
  .requiredOption("--backup-root <path>", "Directory that will retain the old vault")
  .option("--promote", "Revalidate, back up, and atomically promote the sealed staging vault")
  .option("--seal-only", "Validate and seal an already completed staging vault")
  .action(async (options: {
    vault: string;
    staging: string;
    backupRoot: string;
    promote?: boolean;
    sealOnly?: boolean;
  }) => {
    const rebuild = new RebuildService();
    if (options.promote === true) {
      print(await rebuild.promote({
        currentVault: options.vault,
        stagingVault: options.staging,
        backupRoot: options.backupRoot,
      }));
      return;
    }
    if (options.sealOnly === true) {
      print(await rebuild.seal({ currentVault: options.vault, stagingVault: options.staging }));
      return;
    }
    const staging = resolve(options.staging);
    try {
      await access(staging);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await initializeWorkspace({ vault: staging, dryRun: false });
      const currentConfig = await loadWorkspaceConfig(options.vault);
      await writeFile(
        `${staging}/.ckb/config.json`,
        `${JSON.stringify({ ...currentConfig, vaultPath: staging }, null, 2)}\n`,
      );
    }
    const { config, service } = await refreshService(staging);
    const refresh = await service.refresh({ vault: staging, config, dryRun: false, rebuild: true });
    const seal = await rebuild.seal({ currentVault: options.vault, stagingVault: staging });
    print({ refresh, seal });
  });

program
  .command("rollback")
  .description("Restore a verified pre-promotion vault while preserving the current vault for recovery")
  .requiredOption("--vault <path>", "Current permanent vault")
  .requiredOption("--backup <path>", "Verified vault backup created by rebuild --promote")
  .requiredOption("--recovery-root <path>", "Directory that will retain the displaced current vault")
  .action(async (options: { vault: string; backup: string; recoveryRoot: string }) => {
    print(await new RebuildService().rollback({
      currentVault: options.vault,
      backupVault: options.backup,
      failedVaultRoot: options.recoveryRoot,
    }));
  });

const review = program.command("review").description("Manage pending knowledge reviews");

const page = program.command("page").description("Safely read or patch tracked wiki pages");

page
  .command("create")
  .argument("<path>")
  .requiredOption("--vault <path>")
  .requiredOption("--content-file <path>")
  .requiredOption("--source <paths...>", "Readable Notes paths providing the synthesis evidence")
  .action(async (
    path: string,
    options: { vault: string; contentFile: string; source: string[] },
  ) => {
    print(await new CollaborationService(options.vault).createSynthesisPage({
      path,
      content: await readFile(options.contentFile, "utf8"),
      sourcePaths: options.source,
      actor: "human-agent:cli",
    }));
  });

page
  .command("read")
  .argument("<path>")
  .requiredOption("--vault <path>")
  .action(async (path: string, options: { vault: string }) => {
    print(await new CollaborationService(options.vault).readPage(path));
  });

page
  .command("patch")
  .argument("<path>")
  .requiredOption("--vault <path>")
  .requiredOption("--expected-hash <sha256>")
  .requiredOption("--content-file <path>")
  .action(
    async (
      path: string,
      options: { vault: string; expectedHash: string; contentFile: string },
    ) => {
      print(
        await new CollaborationService(options.vault).patchPage({
          path,
          expectedHash: options.expectedHash,
          content: await readFile(options.contentFile, "utf8"),
          actor: "agent:cli",
        }),
      );
    },
  );

review
  .command("list")
  .requiredOption("--vault <path>")
  .action(async (options: { vault: string }) => print(await listReviews(options.vault)));

review
  .command("show")
  .argument("<review-id>")
  .requiredOption("--vault <path>")
  .action(async (reviewId: string, options: { vault: string }) => {
    print(await getReview(options.vault, reviewId));
  });

review
  .command("approve")
  .argument("<review-id>")
  .requiredOption("--vault <path>")
  .action(async (reviewId: string, options: { vault: string }) => {
    await approveReview(options.vault, reviewId);
    print({ reviewId, status: "approved" });
  });

review
  .command("reject")
  .argument("<review-id>")
  .requiredOption("--vault <path>")
  .action(async (reviewId: string, options: { vault: string }) => {
    await rejectReview(options.vault, reviewId);
    print({ reviewId, status: "rejected" });
  });

try {
  await program.parseAsync();
} catch (error: unknown) {
  const candidate = error as { code?: unknown; message?: unknown };
  process.stderr.write(
    `${JSON.stringify({
      code: typeof candidate.code === "string" ? candidate.code : "internal_error",
      message: typeof candidate.message === "string" ? candidate.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
}
