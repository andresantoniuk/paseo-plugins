import { describe, expect, test, vi } from "vitest";
import type { AgentEntry, HostScope } from "../client/monitor";
import { withHostScope } from "../client/monitor";
import {
  fetchInteractions,
  mergeHostInteractions,
  useAllHostsInteractionGraph,
} from "../client/graph-data";

const hooks = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  query: undefined as undefined | { queryKey: unknown[]; queryFn: () => Promise<unknown> },
}));

vi.mock("@getpaseo/plugin/client", () => ({
  getPaseoClient: (serverId: string) => {
    const client = hooks.clients[serverId];
    if (!client) throw new Error(`no client for ${serverId}`);
    return client;
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; queryFn: () => Promise<unknown> }) => {
    hooks.query = options;
    return options;
  },
}));
vi.mock("react", () => ({
  useMemo: (factory: () => unknown) => factory(),
}));

type TimelineRow = { item: unknown };

function timelineClient(timelines: Record<string, unknown[] | Error>) {
  return {
    agents: {
      ref: (id: string) => ({
        timeline: {
          refetch: async () => {
            const timeline = timelines[id];
            if (timeline instanceof Error) throw timeline;
            return { entries: ((timeline ?? []) as unknown[]).map((item) => ({ item })) };
          },
        },
      }),
    },
  };
}

function agentEntry(
  id: string,
  overrides: Partial<AgentEntry["agent"]> = {},
): AgentEntry {
  return {
    agent: {
      id,
      status: "idle",
      updatedAt: "2026-08-25T11:00:00.000Z",
      persistence: null,
      runtimeInfo: null,
      ...overrides,
    },
  } as AgentEntry;
}

describe("fetchInteractions", () => {
  test("counts messages and derives sender edges", async () => {
    const client = timelineClient({
      a: [
        { type: "user_message" },
        { type: "assistant_message" },
        { type: "tool_call", agentMessage: { sender: { id: "b" } } },
        { type: "tool_call", agentMessage: { sender: { id: "a" } } },
        null,
      ],
      b: [{ type: "assistant_message" }],
    });

    const data = await fetchInteractions(client as never, [agentEntry("a"), agentEntry("b")]);

    expect(data.messagesByAgent.get("a")).toBe(2);
    expect(data.messagesByAgent.get("b")).toBe(1);
    expect(data.edges).toEqual([{ from: "b", to: "a", count: 1, kind: "message" }]);
    expect(data.unreadable).toBe(0);
  });

  test("resolves dispatch targets from detail ids and session ids", async () => {
    const client = timelineClient({
      parent: [
        { type: "tool_call", detail: { agentId: "child" } },
        { type: "tool_call", detail: { childSessionId: "session-child" } },
        { type: "tool_call", detail: { agentId: "unknown" } },
        { type: "tool_call", detail: { childSessionId: "unknown-session" } },
        { type: "tool_call", detail: null },
        { type: "tool_call", detail: "not-an-object" },
        { type: "tool_call" },
      ],
    });

    const data = await fetchInteractions(client as never, [
      agentEntry("parent"),
      agentEntry("child", { persistence: { provider: "test", sessionId: "session-child" } }),
      agentEntry("runtime-child", { runtimeInfo: { provider: "test", sessionId: "session-runtime" } }),
    ]);

    expect(data.edges).toEqual([
      { from: "parent", to: "child", count: 2, kind: "tree" },
    ]);
  });

  test("collects subagent dispatches with label fallbacks", async () => {
    const client = timelineClient({
      a: [
        { type: "tool_call", detail: { type: "sub_agent", description: " Researcher " } },
        { type: "tool_call", detail: { type: "sub_agent", subAgentType: "explore" } },
        { type: "tool_call", detail: { type: "sub_agent" } },
        { type: "tool_call", detail: { type: "sub_agent", description: "Researcher" } },
      ],
    });

    const data = await fetchInteractions(client as never, [agentEntry("a")]);

    expect(data.subagents).toEqual([
      { parentId: "a", id: "a>Researcher", label: "Researcher", kind: "subagent", count: 2 },
      { parentId: "a", id: "a>explore", label: "explore", kind: "explore", count: 1 },
      { parentId: "a", id: "a>subagent", label: "subagent", kind: "subagent", count: 1 },
    ]);
  });

  test("prefers open agents and counts unreadable timelines", async () => {
    const client = timelineClient({
      open: [{ type: "user_message" }],
      gone: new Error("gone"),
    });

    const data = await fetchInteractions(client as never, [
      agentEntry("gone", { status: "closed", updatedAt: "2026-08-26T11:00:00.000Z" }),
      agentEntry("open", { status: "idle", updatedAt: "2026-08-25T11:00:00.000Z" }),
    ]);

    expect(data.messagesByAgent.get("open")).toBe(1);
    expect(data.unreadable).toBe(1);
  });
});

describe("mergeHostInteractions", () => {
  test("sums counts and concatenates without leaking maps across hosts", () => {
    const merged = mergeHostInteractions([
      {
        messagesByAgent: new Map([["a", 1]]),
        edges: [{ from: "a", to: "b", count: 1, kind: "tree" }],
        subagents: [],
        unreadable: 0,
      },
      {
        messagesByAgent: new Map([["a", 2]]),
        edges: [],
        subagents: [{ parentId: "a", id: "a>x", label: "x", kind: "task", count: 1 }],
        unreadable: 2,
      },
    ]);

    expect(merged.messagesByAgent.get("a")).toBe(3);
    expect(merged.edges).toHaveLength(1);
    expect(merged.subagents).toHaveLength(1);
    expect(merged.unreadable).toBe(2);
  });
});

describe("useAllHostsInteractionGraph", () => {
  const hostA: HostScope = { serverId: "srv-a", label: "alpha" };
  const hostB: HostScope = { serverId: "srv-b", label: "beta" };

  test("sweeps each host with entries and counts a dead host as unreadable", async () => {
    hooks.clients = {
      "srv-a": timelineClient({ a1: [{ type: "user_message" }] }),
    };
    const entries = [
      withHostScope(agentEntry("a1"), hostA),
      withHostScope(agentEntry("b1"), hostB),
    ];

    useAllHostsInteractionGraph([hostA, hostB], entries, true);
    const data = (await hooks.query?.queryFn()) as {
      messagesByAgent: Map<string, number>;
      unreadable: number;
    };

    expect(data.messagesByAgent.get("a1")).toBe(1);
    expect(data.unreadable).toBe(1);
    expect(hooks.query?.queryKey).toContain("srv-a,srv-b");
  });
});
