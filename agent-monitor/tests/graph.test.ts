import { describe, expect, it } from "vitest";
import { buildGraph, edgeThickness, repoLabel } from "../client/graph";
import type { AgentEntry } from "../client/monitor";

function entry(
  id: string,
  options: {
    parent?: string;
    project?: string;
    workspace?: string;
    cwd?: string;
    status?: string;
  } = {},
): AgentEntry {
  return {
    agent: {
      id,
      title: id,
      status: options.status ?? "idle",
      provider: "claude",
      model: null,
      cwd: options.cwd ?? "/home/andresa/git/_PROJECTS/VDR/vdr",
      labels: options.parent ? { "paseo.parent-agent-id": options.parent } : {},
      pendingPermissions: [],
      requiresAttention: false,
      updatedAt: "2026-10-20T00:00:00.000Z",
      persistence: null,
      runtimeInfo: null,
    },
    project: {
      projectName: options.project ?? "VDR",
      workspaceName: options.workspace ?? "vdr",
      projectKey: "project-key",
      checkout: { isGit: true, currentBranch: "main" },
    },
  } as unknown as AgentEntry;
}

describe("repoLabel", () => {
  it("names the project, workspace and branch", () => {
    expect(repoLabel(entry("agent"))).toBe("VDR / vdr · main");
  });

  it("collapses a workspace that repeats the project name", () => {
    expect(repoLabel(entry("agent", { project: "VDR", workspace: "VDR" }))).toBe("VDR · main");
  });
});

describe("edgeThickness", () => {
  it("grows with the message count but stays bounded", () => {
    const one = edgeThickness(1);
    const ten = edgeThickness(10);
    const thousand = edgeThickness(1000);

    expect(ten).toBeGreaterThan(one);
    expect(thousand).toBeGreaterThanOrEqual(ten);
    expect(thousand).toBeLessThanOrEqual(7);
  });
});

describe("buildGraph", () => {
  it("lays a child to the right of its parent and weights the edge by messages", () => {
    const parent = entry("parent");
    const child = entry("child", { parent: "parent" });
    const layout = buildGraph([parent, child], {
      messagesByAgent: new Map([["child", 7]]),
      edges: [],
      subagents: [],
    });

    expect(layout.nodes).toHaveLength(2);
    expect(layout.byId.has("child")).toBe(true);
    expect(layout.byId.has("parent")).toBe(true);
    expect(layout.edges).toEqual([
      { from: "parent", to: "child", count: 7, kind: "tree" },
    ]);
  });

  it("merges a timeline message edge between agents with no parent link", () => {
    const layout = buildGraph([entry("a"), entry("b")], {
      messagesByAgent: new Map(),
      edges: [{ from: "a", to: "b", count: 3, kind: "message" }],
      subagents: [],
    });

    expect(layout.edges).toEqual([{ from: "a", to: "b", count: 3, kind: "message" }]);
  });

  it("turns provider subagent calls into child nodes", () => {
    const layout = buildGraph([entry("parent")], {
      messagesByAgent: new Map(),
      edges: [],
      subagents: [
        {
          parentId: "parent",
          id: "research",
          label: "Research",
          kind: "general-purpose",
          count: 3,
        },
      ],
    });

    const subagent = layout.nodes.find((node) => node.kind === "subagent");
    expect(subagent?.title).toBe("Research");
    expect(subagent?.messageCount).toBe(3);
    expect(layout.edges).toEqual([
      { from: "parent", to: subagent?.id, count: 3, kind: "subagent" },
    ]);
    expect(layout.clusters).toHaveLength(1);
  });

  it("keeps every node when a parent cycle is malformed", () => {
    const a = entry("a", { parent: "b" });
    const b = entry("b", { parent: "a" });
    const layout = buildGraph([a, b], undefined);

    expect(layout.nodes.map((node) => node.agentId ?? node.id).sort()).toEqual(["a", "b"]);
  });
});
