import { getPaseoClient, type usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { GraphEdge, InteractionData, SubagentInteraction } from "./graph";
import type { AgentEntry, HostScope } from "./monitor";
import { hostOf } from "./monitor";

const TIMELINE_LIMIT = 200;
const MAX_AGENTS = 60;
const CONCURRENCY = 4;

type PaseoApi = ReturnType<typeof usePaseo>;

type TimelineItem = {
  type?: string;
  agentMessage?: { sender?: { id?: string } };
  detail?: unknown;
  [key: string]: unknown;
};

function sessionIdOf(entry: AgentEntry): string | null {
  const persistence = entry.agent.persistence as { sessionId?: string } | null;
  if (persistence?.sessionId) return persistence.sessionId;
  const runtime = entry.agent.runtimeInfo as { sessionId?: string } | null;
  return runtime?.sessionId ?? null;
}

function targetFromDetail(
  detail: unknown,
  agentIds: ReadonlySet<string>,
  sessionToAgent: ReadonlyMap<string, string>,
): string | null {
  if (!detail || typeof detail !== "object") return null;
  const record = detail as Record<string, unknown>;
  for (const key of ["agentId", "childAgentId", "targetAgentId", "parentAgentId"]) {
    const value = record[key];
    if (typeof value === "string" && agentIds.has(value)) return value;
  }
  const childSessionId = record.childSessionId;
  if (typeof childSessionId === "string") return sessionToAgent.get(childSessionId) ?? null;
  return null;
}

/**
 * Reads the tail of each agent's timeline and derives the interaction graph.
 *
 * Parent-child edges come from the directory; this adds two more signals:
 *  - `tool_call.agentMessage.sender` on a timeline item means another agent
 *    wrote to this one, so the edge points from sender to owner.
 *  - a tool-call detail carrying an agent id or a child session id means the
 *    owner dispatched that agent.
 *
 * It is deliberately bounded: the newest 60 agents and 80 timeline entries
 * each. A closed agent with no readable timeline contributes no edges.
 */
export async function fetchInteractions(
  paseo: PaseoApi,
  entries: readonly AgentEntry[],
): Promise<InteractionData> {
  const selected = [...entries]
    .sort((left, right) => {
      const leftClosed = left.agent.status === "closed" ? 1 : 0;
      const rightClosed = right.agent.status === "closed" ? 1 : 0;
      if (leftClosed !== rightClosed) return leftClosed - rightClosed;
      return Date.parse(right.agent.updatedAt) - Date.parse(left.agent.updatedAt);
    })
    .slice(0, MAX_AGENTS);

  const agentIds = new Set(entries.map((entry) => entry.agent.id));
  const sessionToAgent = new Map<string, string>();
  for (const entry of entries) {
    const sessionId = sessionIdOf(entry);
    if (sessionId) sessionToAgent.set(sessionId, entry.agent.id);
  }

  const messagesByAgent = new Map<string, number>();
  const edgeMap = new Map<string, GraphEdge>();
  const subagentMap = new Map<string, SubagentInteraction>();
  let unreadable = 0;
  const addEdge = (from: string, to: string, count: number, kind: GraphEdge["kind"]) => {
    if (!from || !to || from === to) return;
    const key = `${from}>${to}`;
    const existing = edgeMap.get(key);
    if (existing) existing.count += count;
    else edgeMap.set(key, { from, to, count, kind });
  };
  const addSubagent = (parentId: string, label: string, kind: string) => {
    const key = `${parentId}>${label}`;
    const existing = subagentMap.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    subagentMap.set(key, { parentId, id: key, label, kind, count: 1 });
  };

  for (let index = 0; index < selected.length; index += CONCURRENCY) {
    await Promise.all(
      selected.slice(index, index + CONCURRENCY).map(async (entry) => {
        try {
          const payload = await paseo.agents.ref(entry.agent.id).timeline.refetch({
            direction: "tail",
            limit: TIMELINE_LIMIT,
            projection: "projected",
          });
          for (const row of payload.entries ?? []) {
            const item = row.item as TimelineItem;
            if (!item) continue;
            if (item.type === "user_message" || item.type === "assistant_message") {
              messagesByAgent.set(entry.agent.id, (messagesByAgent.get(entry.agent.id) ?? 0) + 1);
            }
            if (item.type !== "tool_call") continue;

            const detail = item.detail as Record<string, unknown> | undefined;
            if (detail?.type === "sub_agent") {
              const label =
                typeof detail.description === "string" && detail.description.trim()
                  ? detail.description.trim()
                  : typeof detail.subAgentType === "string" && detail.subAgentType.trim()
                    ? detail.subAgentType.trim()
                    : "subagent";
              addSubagent(
                entry.agent.id,
                label,
                typeof detail.subAgentType === "string" ? detail.subAgentType : "subagent",
              );
            }

            const sender = item.agentMessage?.sender?.id;
            if (sender && sender !== entry.agent.id) {
              addEdge(sender, entry.agent.id, 1, "message");
            }
            const target = targetFromDetail(detail, agentIds, sessionToAgent);
            if (target) addEdge(entry.agent.id, target, 1, "tree");
          }
        } catch {
          // Closed or unavailable agents simply contribute no interaction data.
          unreadable += 1;
        }
      }),
    );
  }

  return {
    messagesByAgent,
    edges: [...edgeMap.values()],
    subagents: [...subagentMap.values()],
    unreadable,
  };
}

/**
 * Merge per-host interaction data. Agent ids are daemon-scoped UUIDs, so edges
 * and subagent nodes concatenate; the per-host fetch keeps id-to-agent maps
 * from leaking across hosts.
 */
export function mergeHostInteractions(parts: ReadonlyArray<InteractionData>): InteractionData {
  const messagesByAgent = new Map<string, number>();
  const edges: GraphEdge[] = [];
  const subagents: SubagentInteraction[] = [];
  let unreadable = 0;
  for (const part of parts) {
    for (const [agentId, count] of part.messagesByAgent) {
      messagesByAgent.set(agentId, (messagesByAgent.get(agentId) ?? 0) + count);
    }
    edges.push(...part.edges);
    subagents.push(...part.subagents);
    unreadable += part.unreadable ?? 0;
  }
  return { messagesByAgent, edges, subagents, unreadable };
}

/**
 * The graph's multi-host interaction query: one timeline sweep per host that
 * has visible entries, merged into a single interaction set.
 */
export function useAllHostsInteractionGraph(
  hosts: readonly HostScope[],
  entries: readonly AgentEntry[],
  enabled: boolean,
) {
  const byHost = useMemo(() => {
    const grouped = new Map<string, { host: HostScope; entries: AgentEntry[] }>();
    for (const host of hosts) grouped.set(host.serverId, { host, entries: [] });
    for (const entry of entries) {
      const scope = hostOf(entry);
      const group = scope ? grouped.get(scope.serverId) : undefined;
      if (group) group.entries.push(entry);
    }
    return [...grouped.values()].filter((group) => group.entries.length > 0);
  }, [hosts, entries]);
  const ids = byHost
    .map((group) =>
      group.entries
        .map((entry) => entry.agent.id)
        .sort()
        .join(","),
    )
    .join("|");
  const hostIds = byHost.map((group) => group.host.serverId).join(",");
  return useQuery({
    queryKey: ["agent-monitor", "interactions", "all", hostIds, ids],
    queryFn: async () => {
      const parts = await Promise.all(
        byHost.map(async (group) => {
          try {
            return await fetchInteractions(getPaseoClient(group.host.serverId), group.entries);
          } catch {
            return {
              messagesByAgent: new Map<string, number>(),
              edges: [],
              subagents: [],
              unreadable: group.entries.length,
            } satisfies InteractionData;
          }
        }),
      );
      return mergeHostInteractions(parts);
    },
    enabled: enabled && byHost.length > 0,
    staleTime: 20_000,
  });
}
