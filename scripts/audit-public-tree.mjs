#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const skippedDirectories = new Set([".git", "node_modules", "dist"]);
const forbiddenSegments = new Set([
  ".ckb",
  "Backups",
  "Recovery",
  "Knowledge",
  "Notes",
  "Sources",
  "Attachments",
  "Media",
  "Transcripts",
]);
const selfAuditAllowlist = new Set([
  "scripts/audit-public-tree.mjs",
  "tests/scripts/audit-public-tree.test.ts",
]);
const syntheticCredentialFixture =
  "tests/security/sensitivity.test.ts";
const privateIdentityDigests = new Set([
  "4183ac4c8fe6969855d033d804ab4f4e8f2c095a06edb1a903626c6d468d9094",
  "b658ad44c5725af390fd4851faea0094af49ac0d40c9f95603981097984fa6c3",
  "c7f29f8748162abfe9d114a9a04720d749640f67b2e5b5806b4d6689c1f5c67e",
]);

const findings = [];
let scannedFiles = 0;
let allowedSyntheticFixtures = 0;

function portable(relativePath) {
  return relativePath.split(sep).join("/");
}

function forbiddenPathReason(relativePath) {
  const parts = relativePath.split("/");
  const basename = parts.at(-1) ?? "";
  if (basename === "reminder.md") return "forbidden private-data path";
  if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
    return "forbidden private-data path";
  }
  if (
    /\.(?:sqlite(?:-.+)?|db(?:-.+)?|pem|key)$/i.test(basename) ||
    parts.some((part) =>
      forbiddenSegments.has(part) ||
      part.startsWith("Knowledge-")
    )
  ) {
    return "forbidden private-data path";
  }
  return null;
}

function textFindings(relativePath, content) {
  if (selfAuditAllowlist.has(relativePath)) return [];

  const identityMatch = (content.match(/[A-Za-z0-9_-]+/g) ?? []).some((token) => {
    const digest = createHash("sha256").update(token.toLowerCase()).digest("hex");
    return privateIdentityDigests.has(digest);
  });

  const patterns = [
    {
      label: "absolute macOS user path",
      pattern: new RegExp("/" + "Users" + "/[^/\\\\s]+"),
    },
    {
      label: "email address",
      pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    },
    {
      label: "credential-shaped content",
      pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    },
    {
      label: "credential-shaped content",
      pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    },
    {
      label: "credential-shaped content",
      pattern: /\bAKIA[0-9A-Z]{16}\b/,
    },
    {
      label: "private-key block",
      pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/,
    },
  ];

  const matches = identityMatch ? ["personal identity marker"] : [];
  for (const { label, pattern } of patterns) {
    if (!pattern.test(content)) continue;
    if (relativePath === syntheticCredentialFixture) {
      allowedSyntheticFixtures = 1;
      continue;
    }
    matches.push(label);
  }
  return [...new Set(matches)];
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    const relativePath = portable(relative(root, absolutePath));

    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue;
      const pathReason = forbiddenPathReason(relativePath);
      if (pathReason) {
        findings.push({ path: relativePath, reason: pathReason });
        continue;
      }
      await walk(absolutePath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      findings.push({ path: relativePath, reason: "symbolic link is not audited" });
      continue;
    }

    if (!entry.isFile()) continue;
    scannedFiles += 1;

    const pathReason = forbiddenPathReason(relativePath);
    if (pathReason) {
      findings.push({ path: relativePath, reason: pathReason });
      continue;
    }

    const metadata = await lstat(absolutePath);
    if (metadata.size > 5_000_000) {
      findings.push({ path: relativePath, reason: "file exceeds public audit size limit" });
      continue;
    }

    const buffer = await readFile(absolutePath);
    if (buffer.includes(0)) continue;
    const content = buffer.toString("utf8");
    for (const reason of textFindings(relativePath, content)) {
      findings.push({ path: relativePath, reason });
    }
  }
}

await walk(root);

if (findings.length > 0) {
  process.stderr.write("Public-tree audit failed:\n");
  for (const finding of findings) {
    process.stderr.write(`- ${finding.path}: ${finding.reason}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Public-tree audit passed. Files scanned: ${scannedFiles}. Allowed synthetic credential fixtures: ${allowedSyntheticFixtures}.\n`,
  );
}
