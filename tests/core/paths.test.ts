import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoSymlinkAncestors,
  PathEscapeError,
  resolveInside,
  SymlinkPathError,
} from "../../src/index.js";

describe("resolveInside", () => {
  it("resolves a relative path inside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ckb-path-"));
    expect(resolveInside(root, "Wiki/Page.md")).toBe(join(root, "Wiki/Page.md"));
  });

  it("rejects traversal and absolute paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "ckb-path-"));
    expect(() => resolveInside(root, "../outside.md")).toThrow(PathEscapeError);
    expect(() => resolveInside(root, "/tmp/outside.md")).toThrow(PathEscapeError);
  });
});

describe("assertNoSymlinkAncestors", () => {
  it("accepts ordinary directories inside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ckb-path-"));
    await mkdir(join(root, "Wiki"));
    await expect(
      assertNoSymlinkAncestors(root, join(root, "Wiki/Page.md")),
    ).resolves.toBeUndefined();
  });

  it("rejects an internal symlink pointing outside", async () => {
    const root = await mkdtemp(join(tmpdir(), "ckb-path-"));
    const outside = await mkdtemp(join(tmpdir(), "ckb-outside-"));
    await symlink(outside, join(root, "linked"));
    await expect(
      assertNoSymlinkAncestors(root, join(root, "linked/Page.md")),
    ).rejects.toBeInstanceOf(SymlinkPathError);
  });

  it("rejects a target file that is itself a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "ckb-path-"));
    const outside = join(await mkdtemp(join(tmpdir(), "ckb-outside-")), "Page.md");
    await symlink(outside, join(root, "Page.md"));

    await expect(
      assertNoSymlinkAncestors(root, join(root, "Page.md")),
    ).rejects.toBeInstanceOf(SymlinkPathError);
  });
});
