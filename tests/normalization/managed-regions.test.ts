import { describe, expect, it } from "vitest";
import {
  mergeManagedRegions,
  parseManagedRegions,
  renderManagedRegions,
} from "../../src/index.js";

describe("managed first-class note regions", () => {
  it("round-trips upstream, connections, and local additions", () => {
    const content = renderManagedRegions({
      upstream: "# Investments\n\nDurable companies.\n",
      connections: "## Connections\n\n- Parent: [[MOCs/Investments|Investments]]\n",
      local: "## Local additions\n\nQuestion: what would change my mind?\n",
    });

    expect(parseManagedRegions(content)).toEqual({
      upstream: "# Investments\n\nDurable companies.\n",
      connections: "## Connections\n\n- Parent: [[MOCs/Investments|Investments]]\n",
      local: "## Local additions\n\nQuestion: what would change my mind?\n",
    });
  });

  it("rejects missing, reordered, or duplicate boundaries", () => {
    expect(() => parseManagedRegions("plain note\n")).toThrow(/boundaries/i);
    const valid = renderManagedRegions({ upstream: "one\n", connections: "two\n", local: "three\n" });
    expect(() => parseManagedRegions(`${valid}\n<!-- ckb:local:start -->\n`)).toThrow(/duplicate/i);
  });

  it("preserves human connections and local additions when upstream changes", () => {
    const base = { upstream: "upstream v1\n", connections: "generated\n", local: "" };
    const live = { upstream: "upstream v1\n", connections: "human link\n", local: "human thought\n" };
    const next = { upstream: "upstream v2\n", connections: "new generated\n", local: "" };

    expect(mergeManagedRegions({ base, live, next })).toEqual({
      status: "clean",
      regions: {
        upstream: "upstream v2\n",
        connections: "human link\n",
        local: "human thought\n",
      },
    });
  });

  it("keeps a local upstream divergence and blocks a concurrent overlap", () => {
    const base = { upstream: "upstream v1\n", connections: "links\n", local: "" };
    const live = { ...base, upstream: "human upstream edit\n" };
    expect(mergeManagedRegions({ base, live, next: base })).toMatchObject({
      status: "local_divergence",
      regions: { upstream: "human upstream edit\n" },
    });
    expect(mergeManagedRegions({
      base,
      live,
      next: { ...base, upstream: "upstream v2\n" },
    })).toEqual({ status: "conflict", regions: live });
  });
});
