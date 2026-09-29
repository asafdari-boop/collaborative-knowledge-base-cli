import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FixtureNotesExtractor } from "../../src/extractors/fixture.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/apple-notes");

async function stagingDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ckb-fixture-extract-"));
}

describe("fixture notes extractor", () => {
  it("emits the complete extraction contract deterministically", async () => {
    const extractor = new FixtureNotesExtractor(fixtureRoot);
    const options = {
      stagingDirectory: await stagingDirectory(),
      accountAllowlist: ["iCloud"],
      folderAllowlist: [],
      timeoutMs: 1_000,
    };

    const first = await extractor.extract(options);
    const second = await extractor.extract({ ...options, stagingDirectory: await stagingDirectory() });

    expect(first.census.complete).toBe(true);
    expect(first.census.notes).toHaveLength(7);
    expect(first.census.coverage).toEqual({
      requestedAccountAllowlist: ["iCloud"],
      requestedFolderAllowlist: [],
      requestedNoteIdAllowlist: [],
      maximumNoteCount: 20,
      supportedAccounts: ["iCloud"],
      unsupportedAccounts: [],
      noteCount: 7,
    });
    expect(first.census.notes.map((note) => note.id)).toEqual(
      second.census.notes.map((note) => note.id),
    );
    expect(first.census.notes.filter((note) => note.title === "Duplicate title")).toHaveLength(2);

    const linked = first.census.notes.find((note) => note.id.endsWith("/p1"));
    expect(linked).toMatchObject({
      accountName: "iCloud",
      folderName: "Frameworks",
      accessibility: "readable",
    });
    expect(linked?.markdown).toContain("A durable idea");
    expect(linked?.internalLinks).toEqual([
      {
        href: "../People/Example-Thinker.md",
        label: "Example Thinker",
        targetNoteId: "x-coredata://SYNTHETIC/ICNote/p2",
      },
    ]);

    const attachmentNote = first.census.notes.find((note) => note.id.endsWith("/p4"));
    expect(attachmentNote?.attachments).toEqual([
      {
        id: "attachment-1",
        uti: "public.plain-text",
        filename: "evidence.txt",
        relativePath: "iCloud/Research/Evidence (Attachments)/evidence.txt",
        sizeBytes: 27,
      },
    ]);
    expect(first.census.notes.find((note) => note.id.endsWith("/p5"))?.accessibility).toBe(
      "inaccessible",
    );
    expect(first.census.notes.find((note) => note.id.endsWith("/p6"))?.sensitivity).toBe(
      "excluded",
    );
  });

  it("selects duplicate titles by stable ID and enforces the hard ceiling", async () => {
    const extractor = new FixtureNotesExtractor(fixtureRoot);
    const duplicateIds = [
      "x-coredata://SYNTHETIC/ICNote/p3a",
      "x-coredata://SYNTHETIC/ICNote/p3b",
    ];
    const selected = await extractor.extract({
      stagingDirectory: await stagingDirectory(),
      accountAllowlist: ["iCloud"],
      folderAllowlist: [],
      noteIdAllowlist: duplicateIds,
      maximumNoteCount: 2,
      timeoutMs: 1_000,
    });

    expect(selected.census.notes.map((note) => note.id)).toEqual(duplicateIds);
    expect(selected.census.notes.map((note) => note.title)).toEqual([
      "Duplicate title",
      "Duplicate title",
    ]);

    await expect(extractor.extract({
      stagingDirectory: await stagingDirectory(),
      accountAllowlist: [],
      folderAllowlist: [],
      maximumNoteCount: 6,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "incomplete_census" });
  });

  it("supports deterministic partial and failure modes", async () => {
    const partial = new FixtureNotesExtractor(fixtureRoot, { complete: false });
    const options = {
      stagingDirectory: await stagingDirectory(),
      accountAllowlist: [],
      folderAllowlist: [],
      timeoutMs: 1_000,
    };

    expect((await partial.extract(options)).census.complete).toBe(false);

    const failure = new FixtureNotesExtractor(fixtureRoot, {
      failWith: new Error("synthetic extraction failure"),
    });
    await expect(failure.extract(options)).rejects.toThrow("synthetic extraction failure");
  });
});
