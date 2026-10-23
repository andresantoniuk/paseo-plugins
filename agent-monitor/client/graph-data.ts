import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { GraphEdge, InteractionData, SubagentInteraction } from "./graph";
import type { AgentEntry } from "./monitor";

const TIMELINE_LIMIT = 200;
const MAX_AGENTS = 60;
const CONCURRENCY = 4;

type PaseoApi = ReturnType<typeof usePaseo>;

type TimelineItem = {
  type?: string;
  agentMessage?: { sender?: { id?: string; serverId?: string } };
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
  sessionToAgent: ReadonlyMap<string, string>,
): string | null {
  if (!detail || typeof detail !== "object") return null;
  const childSessionId = (detail as Record<string, unknown>).childSessionId;
  return typeof childSessionId === "string" ? (sessionToAgent.get(childSessionId) ?? null) : null;
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
 * It is deliberately bounded: the newest 60 agents and 200 timeline entries
 * each. A closed agent with no readable timeline contributes no edges.
 */
export async function fetchInteractions(
  paseo: PaseoApi,
  hostId: string,
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

            const sender = item.agentMessage?.sender;
            // A sender on another host is not a node here; its id only means something there.
            if (
              sender?.id &&
              sender.id !== entry.agent.id &&
              (!sender.serverId || sender.serverId === hostId)
            ) {
              addEdge(sender.id, entry.agent.id, 1, "message");
            }
            const target = targetFromDetail(detail, sessionToAgent);
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

export function useInteractionGraph(
  hostId: string,
  entries: readonly AgentEntry[],
  enabled: boolean,
) {
  const paseo = usePaseo();
  const ids = entries
    .map((entry) => entry.agent.id)
    .sort()
    .join(",");
  return useQuery({
    queryKey: ["agent-monitor", "interactions", hostId, ids],
    queryFn: () => fetchInteractions(paseo, hostId, entries),
    enabled: enabled && entries.length > 0,
    staleTime: 20_000,
  });
}
