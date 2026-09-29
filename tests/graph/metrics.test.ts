import { describe, expect, it } from "vitest";
import { calculateGraphMetrics } from "../../src/index.js";

describe("graph diagnostics", () => {
  it("reports components, isolates, degree distribution, and hubs", () => {
    const metrics = calculateGraphMetrics([
      { path: "Home.md", content: "[[Domains/A|A]] [[Domains/B|B]]" },
      { path: "Domains/A.md", content: "[[Notes/One|One]]" },
      { path: "Domains/B.md", content: "" },
      { path: "Notes/One.md", content: "" },
      { path: "Notes/Isolated.md", content: "" },
    ]);
    expect(metrics).toMatchObject({ nodes: 5, edges: 3, components: 2, isolates: ["Notes/Isolated.md"] });
    expect(metrics.highestDegree[0]).toMatchObject({ path: "Home.md", degree: 2 });
    expect(metrics.degreeDistribution[0]).toBe(1);
  });
});
