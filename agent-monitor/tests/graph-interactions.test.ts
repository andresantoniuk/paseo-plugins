import { describe, expect, test, vi } from "vitest";
import {
  fetchInteractions,
  mergeHostInteractions,
  useAllHostsInteractionGraph,
} from "../client/graph-data";
import type { AgentEntry, HostScope } from "../client/monitor";
import { withHostScope } from "../client/monitor";

const hooks = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  query: undefined as
    | undefined
    | { queryKey: unknown[]; queryFn: (context?: { signal?: AbortSignal }) => Promise<unknown> },
}));

vi.mock("@getpaseo/plugin/client", () => ({
  getPaseoClient: (serverId: string) => {
    const client = hooks.clients[serverId];
    if (!client) throw new Error(`no client for ${serverId}`);
    return client;
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: {
    queryKey: unknown[];
    queryFn: (context?: { signal?: AbortSignal }) => Promise<unknown>;
  }) => {
    hooks.query = options;
    return options;
  },
}));
vi.mock("react", () => ({
  useMemo: (factory: () => unknown) => factory(),
}));

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

function agentEntry(id: string, overrides: Partial<AgentEntry["agent"]> = {}): AgentEntry {
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

describe("fetchInteractions across hosts", () => {
  test("ignores a sender and a dispatch target that live on another host", async () => {
    const client = timelineClient({
      parent: [
        { type: "tool_call", detail: { agentId: "child" } },
        { type: "tool_call", detail: { childSessionId: "session-child" } },
        { type: "tool_call", agentMessage: { sender: { id: "remote", serverId: "srv-b" } } },
      ],
    });

    const data = await fetchInteractions(client as never, "srv-a", [
      agentEntry("parent"),
      // Same id on this host would resolve, but agent ids are daemon scoped,
      // so a bare agentId never crosses the host boundary.
      agentEntry("child", { persistence: { provider: "test", sessionId: "session-child" } }),
    ]);

    expect(data.edges).toEqual([{ from: "parent", to: "child", count: 1, kind: "tree" }]);
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
    const data = (await hooks.query?.queryFn({})) as {
      messagesByAgent: Map<string, number>;
      unreadable: number;
    };

    expect(data.messagesByAgent.get("a1")).toBe(1);
    expect(data.unreadable).toBe(1);
    expect(hooks.query?.queryKey).toContain("srv-a,srv-b");
  });
});
