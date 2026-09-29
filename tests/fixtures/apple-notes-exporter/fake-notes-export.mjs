import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const scenario = process.argv[2];
const stateDirectory = process.argv[3];
const args = process.argv.slice(4);
const callsPath = join(stateDirectory, "calls.json");

async function readCalls() {
  try {
    return JSON.parse(await readFile(callsPath, "utf8"));
  } catch {
    return [];
  }
}

const calls = await readCalls();
calls.push({ args });
await writeFile(callsPath, `${JSON.stringify(calls, null, 2)}\n`);

const notes = [
  {
    id: "NOTE-AAAA-1111",
    title: "Frameworks",
    folderId: "folder-frameworks",
    folderName: "Frameworks",
    accountId: "account-icloud",
    accountName: "iCloud",
    creationDate: "2025-01-01T00:00:00Z",
    modificationDate: "2026-08-23T18:00:00Z",
    attachmentCount: 1,
    plaintext: null,
  },
  {
    id: "NOTE-BBBB-2222",
    title: "Example Thinker",
    folderId: "folder-people",
    folderName: "People",
    accountId: "account-icloud",
    accountName: "iCloud",
    creationDate: "2025-02-01T00:00:00Z",
    modificationDate: "2026-08-22T12:00:00Z",
    attachmentCount: 0,
    plaintext: null,
  },
];

if (args[0] === "--version") {
  process.stdout.write("2.0.1\n");
} else if (args[0] === "list-accounts") {
  process.stdout.write(
    `${JSON.stringify({ accounts: [{ id: "account-icloud", name: "iCloud", type: "iCloud" }], count: 1 })}\n`,
  );
} else if (args[0] === "list-folders") {
  const folderCalls = calls.filter((call) => call.args[0] === "list-folders").length;
  if (scenario === "empty-folders-once" && folderCalls === 1) {
    process.stdout.write(`${JSON.stringify({ folders: [], count: 0 })}\n`);
    process.exit(0);
  }
  process.stdout.write(
    `${JSON.stringify({
      folders: [
        { id: "folder-frameworks", name: "Frameworks", parentId: null, accountId: "account-icloud", accountName: "Unknown" },
        { id: "folder-people", name: "People", parentId: null, accountId: "account-icloud", accountName: "Unknown" },
      ],
      count: 2,
    })}\n`,
  );
} else if (args[0] === "list-notes") {
  const listCalls = calls.filter((call) => call.args[0] === "list-notes").length;
  const listed = structuredClone(notes);
  if (scenario === "empty-once" && listCalls === 1) {
    process.stdout.write(`${JSON.stringify({ notes: [], count: 0 })}\n`);
    process.exit(0);
  }
  if (scenario === "unknown-names" || scenario === "empty-folders-once") {
    for (const note of listed) {
      note.accountName = "Unknown";
      note.folderName = "Unknown";
    }
  }
  if (scenario === "inline-attachments") {
    listed[0].attachmentCount = 4;
  }
  if (scenario === "unstable" && listCalls > 1) {
    listed[0].modificationDate = "2026-08-24T01:00:00Z";
  }
  process.stdout.write(`${JSON.stringify({ notes: listed, count: listed.length })}\n`);
} else if (args[0] === "export") {
  const exportCalls = calls.filter((call) => call.args[0] === "export").length;
  const outputIndex = args.indexOf("--output");
  const output = args[outputIndex + 1];
  const notesIndex = args.indexOf("--notes");
  const requestedIds = notesIndex === -1
    ? new Set(notes.map((note) => note.id))
    : new Set((args[notesIndex + 1] ?? "").split(",").filter(Boolean));
  const selectedNotes = notes.filter((note) => requestedIds.has(note.id));
  const parentPath = join(output, "iCloud/Frameworks/Frameworks.md");
  const childPath = join(output, "iCloud/People/Example-Thinker.md");
  const attachmentPath = join(
    output,
    "iCloud/Frameworks/Frameworks (Attachments)/evidence.txt",
  );
  if (requestedIds.has("NOTE-AAAA-1111")) {
    await mkdir(dirname(parentPath), { recursive: true });
    await mkdir(dirname(attachmentPath), { recursive: true });
    await writeFile(
      parentPath,
      "# Frameworks\n\nA durable idea links to [Example Thinker](../People/Example-Thinker.md).\n\n[Evidence](Frameworks%20(Attachments)/evidence.txt)\n",
    );
    await writeFile(attachmentPath, "Synthetic attachment data.\n");
  }
  if (requestedIds.has("NOTE-BBBB-2222")) {
    await mkdir(dirname(childPath), { recursive: true });
    await writeFile(childPath, "# Example Thinker\n\nLong-term games.\n");
  }
  const parentExportedPath =
    scenario === "escaped-path" ? "../escaped.md" : "iCloud/Frameworks/Frameworks.md";
  const manifestNotes = {};
  if (requestedIds.has("NOTE-AAAA-1111")) {
    manifestNotes["NOTE-AAAA-1111"] = {
      modificationDate: 1787510000,
      exportedPath: parentExportedPath,
      attachmentPaths: [
        "iCloud/Frameworks/Frameworks (Attachments)/evidence.txt",
      ],
    };
  }
  if (
    (requestedIds.has("NOTE-BBBB-2222") &&
      !(scenario === "missing-manifest-once" && exportCalls === 1)) ||
    scenario === "extra-manifest"
  ) {
    manifestNotes["NOTE-BBBB-2222"] = {
      modificationDate: 1787500000,
      exportedPath: "iCloud/People/Example-Thinker.md",
      attachmentPaths: [],
    };
  }
  await writeFile(
    join(output, "AppleNotesExportSyncWatermark.json"),
    `${JSON.stringify({
      version: 1,
      lastSync: 1787530000,
      notes: manifestNotes,
    }, null, 2)}\n`,
  );
  const failed = scenario === "partial" ? 1 : 0;
  process.stdout.write(
    `${JSON.stringify({
      success: failed === 0,
      exported: selectedNotes.length - failed,
      skipped: 0,
      failed,
      failedAttachments: 0,
      outputDirectory: output,
      format: "md",
      durationSeconds: 0.01,
    })}\n`,
  );
  if (failed > 0) process.exitCode = 1;
} else {
  process.stderr.write(`unknown command: ${args.join(" ")}\n`);
  process.exitCode = 2;
}
