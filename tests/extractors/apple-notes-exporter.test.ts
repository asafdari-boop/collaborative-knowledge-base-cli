import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AppleNotesExporter,
  extractNativeAppleNoteLinks,
  loadNativeNoteIdentifierMap,
} from "../../src/extractors/apple-notes-exporter.js";

const fakeCli = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/apple-notes-exporter/fake-notes-export.mjs",
);

async function setup(scenario = "happy") {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "ckb-exporter-"));
  const extractor = new AppleNotesExporter({
    executable: process.execPath,
    executableArguments: [fakeCli, scenario, stagingDirectory],
  });
  return { stagingDirectory, extractor };
}

describe("Apple Notes Exporter adapter", () => {
  it("maps native Apple Note URLs to stable note IDs by database identifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ckb-native-links-"));
    const databasePath = join(directory, "NoteStore.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER TEXT)");
    database.prepare("INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER) VALUES (?, ?)")
      .run(6058, "9E42D1D2-A05D-41A6-A7A5-10C62EB864C4");
    database.prepare("INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER) VALUES (?, ?)")
      .run(5416, "438D578D-C8BC-4E48-834E-2802578059F3");
    database.close();

    const identifiers = loadNativeNoteIdentifierMap(databasePath);
    expect(extractNativeAppleNoteLinks(
      "Investment watchlist [applenotes:note/9e42d1d2-a05d-41a6-a7a5-10c62eb864c4?ownerIdentifier=owner]" +
      "\u2028Breakup [applenotes:note/438d578d-c8bc-4e48-834e-2802578059f3?ownerIdentifier=owner]\n",
      identifiers,
    )).toEqual([
      {
        href: "applenotes:note/9e42d1d2-a05d-41a6-a7a5-10c62eb864c4?ownerIdentifier=owner",
        label: "Investment watchlist",
        targetNoteId: "6058",
      },
      {
        href: "applenotes:note/438d578d-c8bc-4e48-834e-2802578059f3?ownerIdentifier=owner",
        label: "Breakup",
        targetNoteId: "5416",
      },
    ]);
  });

  it("joins a stable-ID census to confined Markdown and attachments", async () => {
    const { stagingDirectory, extractor } = await setup();
    const result = await extractor.extract({
      stagingDirectory,
      accountAllowlist: ["iCloud"],
      folderAllowlist: [],
      timeoutMs: 2_000,
    });

    expect(result.census.complete).toBe(true);
    expect(result.census.extractor).toEqual({ name: "apple-notes-exporter", version: "2.0.1" });
    expect(result.census.coverage).toMatchObject({
      requestedAccountAllowlist: ["iCloud"],
      supportedAccounts: ["iCloud"],
      unsupportedAccounts: [],
      noteCount: 2,
    });
    expect(result.census.notes.map((note) => note.id)).toEqual([
      "NOTE-AAAA-1111",
      "NOTE-BBBB-2222",
    ]);

    const parent = result.census.notes[0];
    expect(parent).toMatchObject({
      title: "Frameworks",
      exportedRelativePath: "iCloud/Frameworks/Frameworks.md",
      accessibility: "readable",
      sensitivity: "permitted",
    });
    expect(parent?.markdown).toContain("A durable idea");
    expect(parent?.internalLinks).toEqual([
      {
        href: "../People/Example-Thinker.md",
        label: "Example Thinker",
        targetNoteId: "NOTE-BBBB-2222",
      },
    ]);
    expect(parent?.attachments).toEqual([
      {
        id: expect.stringMatching(/^export-path:/),
        uti: "public.plain-text",
        filename: "evidence.txt",
        relativePath: "iCloud/Frameworks/Frameworks (Attachments)/evidence.txt",
        sizeBytes: 27,
      },
    ]);

    const calls = JSON.parse(await readFile(join(stagingDirectory, "calls.json"), "utf8")) as {
      args: string[];
    }[];
    expect(calls.map((call) => call.args[0])).toEqual([
      "--version",
      "list-accounts",
      "list-folders",
      "list-notes",
      "export",
      "list-notes",
    ]);
    expect(calls.find((call) => call.args[0] === "export")?.args).toEqual(
      expect.arrayContaining([
        "--format",
        "markdown",
        "--incremental",
        "--notes",
      ]),
    );
  });

  it("joins account and folder names by stable metadata IDs", async () => {
    const { stagingDirectory, extractor } = await setup("unknown-names");
    const result = await extractor.extract({
      stagingDirectory,
      accountAllowlist: ["iCloud"],
      folderAllowlist: ["Frameworks"],
      maximumNoteCount: 1,
      timeoutMs: 2_000,
    });

    expect(result.census.notes).toHaveLength(1);
    expect(result.census.notes[0]).toMatchObject({
      accountName: "iCloud",
      folderName: "Frameworks",
    });
    const calls = JSON.parse(await readFile(join(stagingDirectory, "calls.json"), "utf8")) as {
      args: string[];
    }[];
    for (const call of calls.filter((candidate) =>
      candidate.args[0] === "list-notes" || candidate.args[0] === "export"
    )) {
      expect(call.args).not.toContain("--account");
      expect(call.args).not.toContain("--folder");
    }
  });

  it("retries an intermittent empty note census before exporting", async () => {
    const { stagingDirectory, extractor } = await setup("empty-once");
    const result = await extractor.extract({
      stagingDirectory,
      accountAllowlist: ["iCloud"],
      folderAllowlist: [],
      maximumNoteCount: 2,
      timeoutMs: 2_000,
    });

    expect(result.census.notes).toHaveLength(2);
    const calls = JSON.parse(await readFile(join(stagingDirectory, "calls.json"), "utf8")) as {
      args: string[];
    }[];
    expect(calls.filter((call) => call.args[0] === "list-notes")).toHaveLength(3);
  });

  it("retries an intermittent empty folder census before applying exact scope", async () => {
    const { stagingDirectory, extractor } = await setup("empty-folders-once");
    const result = await extractor.extract({
      stagingDirectory,
      accountAllowlist: ["iCloud"],
      folderAllowlist: ["Frameworks"],
      maximumNoteCount: 1,
      timeoutMs: 2_000,
    });

    expect(result.census.notes).toHaveLength(1);
    const calls = JSON.parse(await readFile(join(stagingDirectory, "calls.json"), "utf8")) as {
      args: string[];
    }[];
    expect(calls.filter((call) => call.args[0] === "list-folders")).toHaveLength(2);
  });

  it("accepts only a complete whole-scope export attempt", async () => {
    const { stagingDirectory, extractor } = await setup("missing-manifest-once");
    const result = await extractor.extract({
      stagingDirectory,
      accountAllowlist: ["iCloud"],
      folderAllowlist: [],
      maximumNoteCount: 2,
      timeoutMs: 2_000,
    });

    expect(result.census.notes).toHaveLength(2);
    const calls = JSON.parse(await readFile(join(stagingDirectory, "calls.json"), "utf8")) as {
      args: string[];
    }[];
    expect(calls.filter((call) => call.args[0] === "export")).toHaveLength(2);
  });

  it("distinguishes inline Notes objects from file-backed attachments", async () => {
    const { stagingDirectory, extractor } = await setup("inline-attachments");
    const result = await extractor.extract({
      stagingDirectory,
      accountAllowlist: ["iCloud"],
      folderAllowlist: [],
      maximumNoteCount: 2,
      timeoutMs: 2_000,
    });

    expect(result.census.notes[0]?.attachments).toHaveLength(1);
  });

  it("places the copied database option after every database-reading subcommand", async () => {
    const stagingDirectory = await mkdtemp(join(tmpdir(), "ckb-exporter-db-"));
    const extractor = new AppleNotesExporter({
      executable: process.execPath,
      executableArguments: [fakeCli, "happy", stagingDirectory],
      databasePath: "/backups/Apple Notes/NoteStore.sqlite",
    });
    await extractor.extract({
      stagingDirectory,
      accountAllowlist: ["iCloud"],
      folderAllowlist: [],
      maximumNoteCount: 2,
      timeoutMs: 2_000,
    });

    const calls = JSON.parse(await readFile(join(stagingDirectory, "calls.json"), "utf8")) as {
      args: string[];
    }[];
    expect(calls[0]?.args).toEqual(["--version"]);
    for (const call of calls.slice(1)) {
      expect(call.args.slice(0, 3)).toEqual([
        call.args[0],
        "--db",
        "/backups/Apple Notes/NoteStore.sqlite",
      ]);
    }
  });

  it("fails closed when the census changes during export", async () => {
    const { stagingDirectory, extractor } = await setup("unstable");

    await expect(
      extractor.extract({
        stagingDirectory,
        accountAllowlist: [],
        folderAllowlist: [],
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ code: "incomplete_census" });
  });

  it("exports only exact allowlisted stable IDs", async () => {
    const { stagingDirectory, extractor } = await setup();
    const result = await extractor.extract({
      stagingDirectory,
      accountAllowlist: ["iCloud"],
      folderAllowlist: [],
      noteIdAllowlist: ["NOTE-BBBB-2222"],
      maximumNoteCount: 1,
      timeoutMs: 2_000,
    });

    expect(result.census.notes.map((note) => note.id)).toEqual(["NOTE-BBBB-2222"]);
    expect(result.census.coverage).toMatchObject({
      requestedNoteIdAllowlist: ["NOTE-BBBB-2222"],
      maximumNoteCount: 1,
      noteCount: 1,
    });
    const calls = JSON.parse(await readFile(join(stagingDirectory, "calls.json"), "utf8")) as {
      args: string[];
    }[];
    expect(calls.find((call) => call.args[0] === "export")?.args).toEqual(
      expect.arrayContaining(["--notes", "NOTE-BBBB-2222"]),
    );
  });

  it("fails before export when an allowlisted ID is missing or the ceiling is exceeded", async () => {
    const missing = await setup();
    await expect(missing.extractor.extract({
      stagingDirectory: missing.stagingDirectory,
      accountAllowlist: [],
      folderAllowlist: [],
      noteIdAllowlist: ["NOTE-MISSING"],
      maximumNoteCount: 20,
      timeoutMs: 2_000,
    })).rejects.toMatchObject({ code: "incomplete_census" });
    const missingCalls = JSON.parse(
      await readFile(join(missing.stagingDirectory, "calls.json"), "utf8"),
    ) as { args: string[] }[];
    expect(missingCalls.some((call) => call.args[0] === "export")).toBe(false);

    const overflow = await setup();
    await expect(overflow.extractor.extract({
      stagingDirectory: overflow.stagingDirectory,
      accountAllowlist: [],
      folderAllowlist: [],
      maximumNoteCount: 1,
      timeoutMs: 2_000,
    })).rejects.toMatchObject({ code: "incomplete_census" });
    const overflowCalls = JSON.parse(
      await readFile(join(overflow.stagingDirectory, "calls.json"), "utf8"),
    ) as { args: string[] }[];
    expect(overflowCalls.some((call) => call.args[0] === "export")).toBe(false);
  });

  it("rejects manifest entries outside the selected scope", async () => {
    const { stagingDirectory, extractor } = await setup("extra-manifest");
    await expect(extractor.extract({
      stagingDirectory,
      accountAllowlist: [],
      folderAllowlist: [],
      noteIdAllowlist: ["NOTE-AAAA-1111"],
      maximumNoteCount: 1,
      timeoutMs: 2_000,
    })).rejects.toMatchObject({ code: "malformed_export" });
  });

  it("rejects escaped manifest paths and partial exporter results", async () => {
    const escaped = await setup("escaped-path");
    await expect(
      escaped.extractor.extract({
        stagingDirectory: escaped.stagingDirectory,
        accountAllowlist: [],
        folderAllowlist: [],
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ code: "malformed_export" });

    const partial = await setup("partial");
    await expect(
      partial.extractor.extract({
        stagingDirectory: partial.stagingDirectory,
        accountAllowlist: [],
        folderAllowlist: [],
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ code: "incomplete_census" });
  });
});
