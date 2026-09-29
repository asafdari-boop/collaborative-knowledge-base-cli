import { execFileSync } from "node:child_process";
import { join } from "node:path";

export function setup(): void {
  execFileSync(
    process.execPath,
    [join(process.cwd(), "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    { cwd: process.cwd(), stdio: "pipe" },
  );
}
