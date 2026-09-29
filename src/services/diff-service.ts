import type { CkbConfig } from "../config/schema.js";
import type { RefreshResult, RefreshService } from "./refresh-service.js";

export interface DiffOptions {
  vault: string;
  config: CkbConfig;
  signal?: AbortSignal;
}

export class DiffService {
  public constructor(private readonly refreshService: RefreshService) {}

  public async diff(options: DiffOptions): Promise<RefreshResult> {
    return this.refreshService.refresh({
      vault: options.vault,
      config: options.config,
      dryRun: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}
