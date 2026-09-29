import type { ExtractionCensus } from "../extractors/types.js";
import type { SourceState } from "../state/types.js";

export function canInferMissingUpstream(census: ExtractionCensus): boolean {
  return (
    census.complete &&
    census.coverage.requestedAccountAllowlist.length === 0 &&
    census.coverage.requestedFolderAllowlist.length === 0 &&
    census.coverage.unsupportedAccounts.length === 0
  );
}

export function sourceWasInCompleteScope(
  source: SourceState,
  census: ExtractionCensus,
): boolean {
  return canInferMissingUpstream(census) && census.coverage.supportedAccounts.includes(source.account);
}
