const mode = process.argv[2];

if (mode === "emit") {
  process.stdout.write('{"ok":true}\n');
  process.stderr.write("progress only\n");
  process.exitCode = 7;
} else if (mode === "large") {
  process.stdout.write("x".repeat(1024));
} else if (mode === "sleep") {
  setTimeout(() => process.stdout.write("late\n"), 5_000);
} else {
  process.stderr.write(`unknown mode: ${String(mode)}\n`);
  process.exitCode = 2;
}
