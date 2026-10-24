import { describe, expect, it, vi } from "vitest";
import { buildGraph, edgeThickness, repoLabel } from "../client/graph";
import { fetchInteractions, useInteractionGraph } from "../client/graph-data";
import type { AgentEntry } from "../client/monitor";

const hooks = vi.hoisted(() => ({
  paseo: undefined as unknown,
  query: undefined as undefined | Record<string, unknown>,
}));

vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: () => hooks.paseo }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: Record<string, unknown>) => {
    hooks.query = options;
    return options;
  },
}));
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

  it("keeps visible parents' subagents when hidden parents fill the cap", () => {
    const hidden = Array.from({ length: 81 }, (_, index) => ({
      parentId: "ghost",
      id: `ghost>task-${index}`,
      label: `task-${index}`,
      kind: "x",
      count: 10,
    }));
    const layout = buildGraph(
      [entry("parent")],
      {
        messagesByAgent: new Map(),
        edges: [],
        subagents: [
          ...hidden,
          { parentId: "parent", id: "parent>Research", label: "Research", kind: "x", count: 1 },
        ],
      },
      HOST,
    );

    const subagents = layout.nodes.filter((node) => node.kind === "subagent");
    expect(subagents.map((node) => node.title)).toEqual(["Research"]);
  });

  it("keeps subagents whose labels collide under a string hash apart", () => {
    // "Aa" and "BB" share the same 31-multiplier hash.
    const layout = buildGraph(
      [entry("parent")],
      {
        messagesByAgent: new Map(),
        edges: [],
        subagents: [
          { parentId: "parent", id: "parent>Aa", label: "Aa", kind: "x", count: 2 },
          { parentId: "parent", id: "parent>BB", label: "BB", kind: "x", count: 3 },
        ],
      },
      HOST,
    );

    const subagents = layout.nodes.filter((node) => node.kind === "subagent");
    expect(subagents.map((node) => [node.title, node.messageCount]).sort()).toEqual([
      ["Aa", 2],
      ["BB", 3],
    ]);
    expect(new Set(subagents.map((node) => node.id)).size).toBe(2);
    expect(layout.edges).toHaveLength(2);
  });

  it("keeps the message kind when a message edge merges with a tree edge", () => {
    const parent = entry("parent");
    const child = entry("child", { parent: "parent" });
    const layout = buildGraph(
      [parent, child],
      {
        messagesByAgent: new Map([["child", 1]]),
        edges: [{ from: "parent", to: "child", count: 2, kind: "message" }],
        subagents: [],
      },
      HOST,
    );

    expect(layout.edges).toEqual([{ from: "parent", to: "child", count: 3, kind: "message" }]);
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

  it.each([
    ["message resolves last", ["a", "b"]],
    ["tree resolves last", ["b", "a"]],
  ])("keeps the message kind on a shared edge when %s", async (_name, order) => {
    // Agent a dispatches b's session (tree a>b); agent b records a message from a (message a>b).
    const timelines: Record<string, Row[]> = {
      a: [toolCall({ detail: { type: "sub_agent", childSessionId: "session-b" } })],
      b: [toolCall({ agentMessage: { sender: { id: "a" } } })],
    };
    const release: Record<string, () => void> = {};
    const paseo = {
      agents: {
        ref: (id: string) => ({
          timeline: {
            refetch: () => {
              const { promise, resolve } = Promise.withResolvers();
              release[id] = () => resolve({ entries: timelines[id] });
              return promise;
            },
          },
        }),
      },
    } as unknown as Parameters<typeof fetchInteractions>[0];

    const pending = fetchInteractions(paseo, HOST, [
      entry("a"),
      entry("b", { sessionId: "session-b" }),
    ]);
    for (const id of order) release[id]?.();
    const data = await pending;

    expect(data.edges).toEqual([{ from: "a", to: "b", count: 2, kind: "message" }]);
  });

  it("stops reading further batches once the signal aborts", async () => {
    const controller = new AbortController();
    const refetch = vi.fn(async () => {
      controller.abort();
      return { entries: [] };
    });
    const paseo = {
      agents: { ref: () => ({ timeline: { refetch } }) },
    } as unknown as Parameters<typeof fetchInteractions>[0];
    const entries = ["a", "b", "c", "d", "e", "f"].map((id) => entry(id));

    await expect(fetchInteractions(paseo, HOST, entries, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    // The first batch of four was already in flight; the second never starts.
    expect(refetch).toHaveBeenCalledTimes(4);
  });

  it("does not read any timeline when the signal is already aborted", async () => {
    const refetch = vi.fn(async () => ({ entries: [] }));
    const paseo = {
      agents: { ref: () => ({ timeline: { refetch } }) },
    } as unknown as Parameters<typeof fetchInteractions>[0];
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchInteractions(paseo, HOST, [entry("a")], controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe("useInteractionGraph", () => {
  it("re-reads a stable roster on the monitor's 30s foreground interval", () => {
    useInteractionGraph(HOST, [entry("a")], true);

    expect(hooks.query).toMatchObject({ enabled: true, refetchInterval: 30_000 });
    expect(hooks.query?.refetchIntervalInBackground).toBeFalsy();
  });

  it("stays disabled for another view or an empty roster", () => {
    useInteractionGraph(HOST, [entry("a")], false);
    expect(hooks.query?.enabled).toBe(false);

    useInteractionGraph(HOST, [], true);
    expect(hooks.query?.enabled).toBe(false);
  });

  it("hands the query's abort signal to the fetch", async () => {
    hooks.paseo = fakePaseo({ a: [] });
    useInteractionGraph(HOST, [entry("a")], true);
    const queryFn = hooks.query?.queryFn as (context: { signal: AbortSignal }) => Promise<unknown>;
    const controller = new AbortController();
    controller.abort();

    await expect(queryFn({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(queryFn({ signal: new AbortController().signal })).resolves.toMatchObject({
      unreadable: 0,
    });
  });
});
