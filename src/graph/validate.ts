import { CompilerValidationError } from "../core/errors.js";
import type { RenderedGraphPage } from "./render.js";

export interface RenderedGraphValidation {
  links: number;
  unresolved: Array<{ page: string; target: string }>;
}

export function extractWikilinkTargets(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\](?!\()/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter(Boolean);
}

export function validateRenderedGraph(pages: RenderedGraphPage[]): RenderedGraphValidation {
  const known = new Set<string>();
  for (const page of pages) {
    known.add(page.path);
    known.add(page.path.replace(/\.md$/, ""));
  }
  const unresolved: Array<{ page: string; target: string }> = [];
  let links = 0;
  for (const page of pages) {
    for (const target of extractWikilinkTargets(page.content)) {
      links += 1;
      if (/apple-note-[0-9a-f]{8,}/i.test(target)) {
        throw new CompilerValidationError(`Rendered graph contains a hash-named link: ${target}`);
      }
      if (!known.has(target) && !known.has(`${target}.md`)) unresolved.push({ page: page.path, target });
    }
  }
  if (unresolved.length) {
    throw new CompilerValidationError(
      `Rendered graph contains ${unresolved.length} unresolved wikilink${unresolved.length === 1 ? "" : "s"}: ${unresolved[0]!.target}`,
    );
  }
  return { links, unresolved };
}
