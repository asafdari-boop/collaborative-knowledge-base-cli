import { createWiki } from "llm-wiki-compiler";
import { CompilerValidationError } from "../core/errors.js";
import { collectCompilerProposals, verifyCompilerSources } from "./validate-output.js";
import type {
  CompilerAdapterInput,
  CompilerAdapterResult,
  KnowledgeCompiler,
  LlmwikiFactory,
} from "./types.js";

export const LLMWIKI_VERSION = "1.1.0";

const defaultFactory: LlmwikiFactory = ({ root }) => {
  const wiki = createWiki({ root });
  return {
    compile: (options) => wiki.compile(options),
    lint: () => wiki.lint(),
  };
};

export class LlmwikiCompilerAdapter implements KnowledgeCompiler {
  public constructor(private readonly factory: LlmwikiFactory = defaultFactory) {}

  public async compile(input: CompilerAdapterInput): Promise<CompilerAdapterResult> {
    const previousProvider = process.env.LLMWIKI_PROVIDER;
    if (input.provider) process.env.LLMWIKI_PROVIDER = input.provider;
    try {
      const wiki = this.factory({ root: input.project.root });
      let compile;
      try {
        compile = await wiki.compile({ review: false, concurrency: input.concurrency });
      } catch (error: unknown) {
        throw new CompilerValidationError(
          `llmwiki compile failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (compile.errors.length > 0) {
        throw new CompilerValidationError(`llmwiki reported errors: ${compile.errors.join("; ")}`);
      }
      if ((compile.candidates?.length ?? 0) > 0) {
        throw new CompilerValidationError("llmwiki held internal candidates instead of emitting pages");
      }
      await verifyCompilerSources(input.project);
      const lint = await wiki.lint();
      if (lint.errors > 0) {
        const detail = lint.results
          .filter((result) => result.severity === "error")
          .map((result) => `${result.rule}: ${result.message}`)
          .join("; ");
        throw new CompilerValidationError(`llmwiki lint failed: ${detail}`);
      }
      const proposals = await collectCompilerProposals(input.vault, input.project);
      return {
        compiler: { name: "llm-wiki-compiler", version: LLMWIKI_VERSION },
        compile,
        lint,
        proposals,
        stagingRoot: input.project.root,
      };
    } finally {
      if (input.provider) {
        if (previousProvider === undefined) delete process.env.LLMWIKI_PROVIDER;
        else process.env.LLMWIKI_PROVIDER = previousProvider;
      }
    }
  }
}
