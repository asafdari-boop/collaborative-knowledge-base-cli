import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/extractors/process-runner.js";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/apple-notes-exporter/fake-process.mjs",
);

describe("bounded external process runner", () => {
  it("keeps stdout, stderr, and exit status separate without a shell", async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: [fixture, "emit"],
      timeoutMs: 1_000,
      maxOutputBytes: 10_000,
    });

    expect(result).toEqual({
      stdout: '{"ok":true}\n',
      stderr: "progress only\n",
      exitCode: 7,
      signal: null,
    });
  });

  it("terminates processes that exceed time or output bounds", async () => {
    await expect(
      runProcess({
        executable: process.execPath,
        args: [fixture, "sleep"],
        timeoutMs: 20,
        maxOutputBytes: 10_000,
      }),
    ).rejects.toMatchObject({ code: "process_timeout" });

    await expect(
      runProcess({
        executable: process.execPath,
        args: [fixture, "large"],
        timeoutMs: 1_000,
        maxOutputBytes: 32,
      }),
    ).rejects.toMatchObject({ code: "process_output_limit" });
  });

  it("honors cancellation", async () => {
    const controller = new AbortController();
    const pending = runProcess({
      executable: process.execPath,
      args: [fixture, "sleep"],
      timeoutMs: 1_000,
      maxOutputBytes: 10_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
