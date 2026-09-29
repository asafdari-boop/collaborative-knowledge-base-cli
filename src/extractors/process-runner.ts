import { spawn } from "node:child_process";
import {
  ProcessOutputLimitError,
  ProcessSpawnError,
  ProcessTimeoutError,
} from "../core/errors.js";

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

function abortError(): Error {
  const error = new Error("The external process was cancelled");
  error.name = "AbortError";
  return error;
}

export const runProcess: ProcessRunner = async (request) => {
  request.signal?.throwIfAborted();

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      cleanup();
      reject(error);
    };
    const onAbort = (): void => fail(abortError());
    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > request.maxOutputBytes) {
        fail(new ProcessOutputLimitError(request.executable, request.maxOutputBytes));
        return;
      }
      target.push(buffer);
    };

    const timeout = setTimeout(
      () => fail(new ProcessTimeoutError(request.executable, request.timeoutMs)),
      request.timeoutMs,
    );
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      fail(new ProcessSpawnError(request.executable, error.message));
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
      });
    });
  });
};
