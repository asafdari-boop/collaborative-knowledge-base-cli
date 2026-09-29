import { describe, expect, it } from "vitest";
import { CkbConfigSchema } from "../../src/index.js";

describe("configuration schema", () => {
  it("supplies safe source-pipeline defaults without credential fields", () => {
    const config = CkbConfigSchema.parse({
      schemaVersion: 1,
      vaultPath: "/tmp/knowledge",
    });

    expect(config.schemaVersion).toBe(2);

    expect(config.extractor).toEqual({
      executable: "notes-export",
      accountAllowlist: [],
      folderAllowlist: [],
      noteIdAllowlist: [],
      maximumNoteCount: 20,
      timeoutMs: 300_000,
    });
    expect(config.compiler).toEqual({
      primary: { adapter: "llmwiki", provider: "environment" },
      fallback: null,
      fallbackPolicy: "manual",
      concurrency: 3,
    });
    expect(config.sensitivity).toEqual({
      excludedNoteIds: [],
      excludedTitlePatterns: [],
      redactSecrets: true,
    });
    expect(config.attachmentMaxBytes).toBe(100 * 1024 * 1024);
    expect(config.graph).toEqual({
      taxonomyVersion: 1,
      pathPolicyVersion: 1,
      inferenceCapPerNote: 5,
      mocDirectChildLimit: 50,
      missingNoteRetention: "retain",
      graphExclusions: ["Attachments", "Reviews", "System", ".ckb"],
    });
    expect(JSON.stringify(config)).not.toMatch(/api.?key|access.?token|secret.?key|password/i);
  });

  it("accepts explicit extraction scope and rejects invalid limits", () => {
    const config = CkbConfigSchema.parse({
      schemaVersion: 1,
      vaultPath: "/tmp/knowledge",
      extractor: {
        executable: "/Applications/Apple Notes Exporter.app/Contents/MacOS/notes-export",
        databasePath: "/backups/Apple Notes/NoteStore.sqlite",
        accountAllowlist: ["iCloud"],
        folderAllowlist: ["Research"],
        noteIdAllowlist: ["note-public", "note-second"],
        maximumNoteCount: 385,
        timeoutMs: 60_000,
      },
      compiler: { adapter: "llmwiki", concurrency: 1, provider: "claude-agent" },
      sensitivity: {
        excludedNoteIds: ["note-private"],
        excludedTitlePatterns: ["^Passwords$"],
        redactSecrets: false,
      },
      attachmentMaxBytes: 10_000,
    });

    expect(config.extractor.accountAllowlist).toEqual(["iCloud"]);
    expect(config.extractor.databasePath).toBe("/backups/Apple Notes/NoteStore.sqlite");
    expect(config.extractor.noteIdAllowlist).toEqual(["note-public", "note-second"]);
    expect(config.extractor.maximumNoteCount).toBe(385);
    expect(config.compiler.primary).toEqual({
      adapter: "llmwiki",
      provider: "claude-agent",
    });
    expect(config.sensitivity.excludedTitlePatterns).toEqual(["^Passwords$"]);
    expect(() =>
      CkbConfigSchema.parse({
        schemaVersion: 1,
        vaultPath: "/tmp/knowledge",
        attachmentMaxBytes: 0,
      }),
    ).toThrow();
  });

  it("accepts Codex primary with a manual llmwiki fallback", () => {
    const config = CkbConfigSchema.parse({
      schemaVersion: 1,
      vaultPath: "/tmp/knowledge",
      compiler: {
        primary: {
          adapter: "codex-agent",
          executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
        fallback: { adapter: "llmwiki", provider: "claude-agent" },
        fallbackPolicy: "manual",
        concurrency: 3,
      },
    });

    expect(config.compiler.primary).toMatchObject({
      adapter: "codex-agent",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(config.compiler.fallback).toEqual({
      adapter: "llmwiki",
      provider: "claude-agent",
    });
    expect(JSON.stringify(config)).not.toMatch(/api.?key|access.?token|secret.?key|password/i);
  });

  it("rejects invalid Codex strategy values", () => {
    const base = { schemaVersion: 1 as const, vaultPath: "/tmp/knowledge" };
    expect(() => CkbConfigSchema.parse({
      ...base,
      compiler: {
        primary: {
          adapter: "codex-agent",
          executable: "relative/codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      },
    })).toThrow();
    expect(() => CkbConfigSchema.parse({
      ...base,
      compiler: {
        primary: {
          adapter: "codex-agent",
          executable: "/Applications/Codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "impossible",
        },
      },
    })).toThrow();
  });

  it("rejects unsafe extraction identities and limits", () => {
    const base = { schemaVersion: 1 as const, vaultPath: "/tmp/knowledge" };

    expect(() => CkbConfigSchema.parse({
      ...base,
      extractor: { databasePath: "relative/NoteStore.sqlite" },
    })).toThrow();
    expect(() => CkbConfigSchema.parse({
      ...base,
      extractor: { noteIdAllowlist: ["duplicate", "duplicate"] },
    })).toThrow();
    expect(() => CkbConfigSchema.parse({
      ...base,
      extractor: { maximumNoteCount: 0 },
    })).toThrow();
  });
});
