import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWorkspaceLock, initializeWorkspace } from "../../src/index.js";

describe("workspace lock", () => {
  it("rejects a concurrent writer and can be reacquired after release", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ckb-lock-"));
    await initializeWorkspace({ vault, dryRun: false });
    const first = await acquireWorkspaceLock(vault);

    await expect(acquireWorkspaceLock(vault)).rejects.toMatchObject({
      code: "workspace_locked",
    });
    await first.release();
    await expect(access(join(vault, ".ckb/lock"))).rejects.toMatchObject({ code: "ENOENT" });

    const second = await acquireWorkspaceLock(vault);
    await second.release();
  });
});
