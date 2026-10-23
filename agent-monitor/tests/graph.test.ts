import { describe, expect, it } from "vitest";
import { buildGraph, edgeThickness, repoLabel } from "../client/graph";
import { fetchInteractions } from "../client/graph-data";
import type { AgentEntry } from "../client/monitor";

const HOST = "host-a";

function entry(
  id: string,
  options: {
    parent?: string;
    parentServer?: string;
    project?: string;
    workspace?: string;
    cwd?: string;
    status?: string;
    sessionId?: string;
  } = {},
): AgentEntry {
  const labels: Record<string, string> = {};
  if (options.parent) labels["paseo.parent-agent-id"] = options.parent;
  if (options.parentServer) labels["paseo.parent-server-id"] = options.parentServer;
  return {
    agent: {
      id,
      title: id,
      status: options.status ?? "idle",
      provider: "claude",
      model: null,
      cwd: options.cwd ?? "/home/dev/acme/web",
      labels,
      pendingPermissions: [],
      requiresAttention: false,
      updatedAt: "2026-10-20T00:00:00.000Z",
      persistence: options.sessionId ? { sessionId: options.sessionId } : null,
      runtimeInfo: null,
    },
    project: {
      projectName: options.project ?? "Acme",
      workspaceName: options.workspace ?? "web",
      projectKey: "project-key",
      checkout: { isGit: true, currentBranch: "main" },
    },
  } as unknown as AgentEntry;
}

describe("repoLabel", () => {
  it("names the project, workspace and branch", () => {
    expect(repoLabel(entry("agent"))).toBe("Acme / web · main");
  });

  it("collapses a workspace that repeats the project name", () => {
    expect(
      repoLabel(entry("agent", { project: "Acme", workspace: "Acme", cwd: "/home/dev/acme" })),
    ).toBe("Acme · main");
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
  it("draws a parent edge weighted by the child's messages", () => {
    const parent = entry("parent");
    const child = entry("child", { parent: "parent" });
    const layout = buildGraph(
      [parent, child],
      { messagesByAgent: new Map([["child", 7]]), edges: [], subagents: [] },
      HOST,
    );

    expect(layout.nodes).toHaveLength(2);
    expect(layout.byId.get("parent")?.childCount).toBe(1);
    expect(layout.edges).toEqual([{ from: "parent", to: "child", count: 7, kind: "tree" }]);
  });

  it("does not link an agent delegated from another host to a local agent with the same id", () => {
    const local = entry("parent");
    const delegated = entry("child", { parent: "parent", parentServer: "host-b" });
    const layout = buildGraph([local, delegated], undefined, HOST);

    expect(layout.byId.get("child")?.parentId).toBeNull();
    expect(layout.byId.get("parent")?.childCount).toBe(0);
    expect(layout.edges).toEqual([]);
  });

  it("merges a timeline message edge between agents with no parent link", () => {
    const layout = buildGraph(
      [entry("a"), entry("b")],
      {
        messagesByAgent: new Map(),
        edges: [{ from: "a", to: "b", count: 3, kind: "message" }],
        subagents: [],
      },
      HOST,
    );

    expect(layout.edges).toEqual([{ from: "a", to: "b", count: 3, kind: "message" }]);
  });

  it("turns provider subagent calls into child nodes", () => {
    const layout = buildGraph(
      [entry("parent")],
      {
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
      },
      HOST,
    );

    const subagent = layout.nodes.find((node) => node.kind === "subagent");
    expect(subagent?.title).toBe("Research");
    expect(subagent?.messageCount).toBe(3);
    expect(layout.edges).toEqual([
      { from: "parent", to: subagent?.id, count: 3, kind: "subagent" },
    ]);
    expect(layout.clusters).toHaveLength(1);
  });

  it("omits subagent nodes when asked", () => {
    const layout = buildGraph(
      [entry("parent")],
      {
        messagesByAgent: new Map(),
        edges: [],
        subagents: [{ parentId: "parent", id: "r", label: "Research", kind: "x", count: 1 }],
      },
      HOST,
      { includeSubagents: false },
    );

    expect(layout.nodes.map((node) => node.kind)).toEqual(["agent"]);
  });

  it("keeps every node when a parent cycle is malformed", () => {
    const a = entry("a", { parent: "b" });
    const b = entry("b", { parent: "a" });
    const layout = buildGraph([a, b], undefined, HOST);

    expect(layout.nodes.map((node) => node.agentId ?? node.id).sort()).toEqual(["a", "b"]);
  });
});

type Row = { item: Record<string, unknown> };

function fakePaseo(timelines: Record<string, Row[] | Error>) {
  return {
    agents: {
      ref: (id: string) => ({
        timeline: {
          refetch: async () => {
            const result = timelines[id];
            if (result instanceof Error) throw result;
            return { entries: result ?? [] };
          },
        },
      }),
    },
  } as unknown as Parameters<typeof fetchInteractions>[0];
}

const message = (type: string): Row => ({ item: { type, text: "hi" } });
const toolCall = (extra: Record<string, unknown>): Row => ({
  item: { type: "tool_call", name: "tool", ...extra },
});

describe("fetchInteractions", () => {
  it("counts messages and links a sender to the agent it wrote to", async () => {
    const paseo = fakePaseo({
      a: [message("user_message"), message("assistant_message"), message("reasoning")],
      b: [toolCall({ agentMessage: { sender: { id: "a" } } })],
    });

    const data = await fetchInteractions(paseo, HOST, [entry("a"), entry("b")]);

    expect(data.messagesByAgent.get("a")).toBe(2);
    expect(data.edges).toEqual([{ from: "a", to: "b", count: 1, kind: "message" }]);
  });

  it("ignores a message sender that lives on another host", async () => {
    const paseo = fakePaseo({
      a: [toolCall({ agentMessage: { sender: { id: "b", serverId: "host-b" } } })],
      c: [toolCall({ agentMessage: { sender: { id: "b", serverId: HOST } } })],
    });

    const data = await fetchInteractions(paseo, HOST, [entry("a"), entry("b"), entry("c")]);

    expect(data.edges).toEqual([{ from: "b", to: "c", count: 1, kind: "message" }]);
  });

  it("groups provider subagent calls and resolves a child session to a local agent", async () => {
    const paseo = fakePaseo({
      parent: [
        toolCall({
          detail: { type: "sub_agent", description: "Research", subAgentType: "explore" },
        }),
        toolCall({
          detail: { type: "sub_agent", description: "Research", subAgentType: "explore" },
        }),
        toolCall({ detail: { type: "sub_agent", childSessionId: "session-child" } }),
      ],
    });

    const data = await fetchInteractions(paseo, HOST, [
      entry("parent"),
      entry("child", { sessionId: "session-child" }),
    ]);

    expect(data.subagents).toEqual([
      { parentId: "parent", id: "parent>Research", label: "Research", kind: "explore", count: 2 },
      { parentId: "parent", id: "parent>subagent", label: "subagent", kind: "subagent", count: 1 },
    ]);
    expect(data.edges).toEqual([{ from: "parent", to: "child", count: 1, kind: "tree" }]);
  });

  it("counts unreadable timelines and still reads the rest", async () => {
    const paseo = fakePaseo({
      a: new Error("closed"),
      b: [message("user_message")],
    });

    const data = await fetchInteractions(paseo, HOST, [entry("a"), entry("b")]);

    expect(data.unreadable).toBe(1);
    expect(data.messagesByAgent.get("b")).toBe(1);
  });
});
