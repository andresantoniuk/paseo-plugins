import type { AgentEntry } from "./monitor";
import { parentAgentId, placement, stateLabel, title } from "./monitor";

export type GraphEdgeKind = "tree" | "message" | "subagent";

export type GraphEdge = {
  from: string;
  to: string;
  count: number;
  kind: GraphEdgeKind;
};

/** A provider-native subagent invocation found in an agent's timeline. */
export type SubagentInteraction = {
  parentId: string;
  id: string;
  label: string;
  kind: string;
  count: number;
};

/** Timeline-derived interaction data: messages per agent, edges, and provider subagents. */
export type InteractionData = {
  messagesByAgent: ReadonlyMap<string, number>;
  edges: readonly GraphEdge[];
  subagents: readonly SubagentInteraction[];
  /** Timelines that could not be read (closed, removed, or timed out). */
  unreadable?: number;
};

export type GraphNode = {
  id: string;
  kind: "agent" | "subagent";
  title: string;
  repo: string;
  meta: string;
  status: string;
  /** Stable color key: project + workspace. */
  colorKey: string;
  messageCount: number;
  childCount: number;
  parentId: string | null;
  agentId: string | null;
  entry: AgentEntry | null;
  x: number;
  y: number;
};

export type GraphCluster = {
  key: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
};

export type GraphLayout = {
  nodes: GraphNode[];
  byId: Map<string, GraphNode>;
  edges: GraphEdge[];
  clusters: GraphCluster[];
  width: number;
  height: number;
};

export type GraphOptions = {
  includeSubagents?: boolean;
};

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 92;
export const GRAPH_PADDING = 48;

/** The project, workspace, branch and last cwd segment: enough to read the repo at a glance. */
export function repoLabel(entry: AgentEntry): string {
  const project = entry.project.projectName?.trim() || "Agent";
  const workspace = entry.project.workspaceName?.trim();
  const scope = workspace && workspace !== project ? `${project} / ${workspace}` : project;
  const branch = entry.project.checkout.isGit ? entry.project.checkout.currentBranch : null;
  const cwd = entry.agent.cwd.split("/").filter(Boolean).pop() ?? "";
  const repo = branch ? `${scope} · ${branch}` : scope;
  return cwd && !scope.toLowerCase().includes(cwd.toLowerCase()) ? `${repo} · ${cwd}` : repo;
}

/** Edge weight: messages are counted on a log scale so one chatty agent cannot swamp the graph. */
export function edgeThickness(count: number): number {
  return 1 + Math.min(6, Math.log2(Math.max(1, count) + 1) * 1.7);
}

export function edgeLabel(count: number): string {
  return count > 1 ? String(count) : "";
}

function shortId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function mergeEdge(
  edges: Map<string, GraphEdge>,
  from: string,
  to: string,
  count: number,
  kind: GraphEdgeKind,
  mode: "add" | "max",
): void {
  if (!from || !to || from === to) return;
  const key = `${from}>${to}`;
  const existing = edges.get(key);
  if (!existing) {
    edges.set(key, { from, to, count, kind });
    return;
  }
  existing.count = mode === "max" ? Math.max(existing.count, count) : existing.count + count;
  if (kind === "message") existing.kind = "message";
}

/**
 * A clustered force layout for agents and their provider subagents.
 *
 * Paseo agents and provider-native subagents live in different universes: the
 * former have `parentAgentId`, the latter only appear as `Task`/`Agent` tool
 * calls in a timeline. Both are nodes here, with the invocation count as the
 * edge weight. A cluster attraction keeps each project/workspace together so
 * the canvas reads as groups instead of a cloud.
 */
export function buildGraph(
  entries: readonly AgentEntry[],
  interactions: InteractionData | undefined,
  options: GraphOptions = {},
): GraphLayout {
  const nodes: GraphNode[] = entries.map((entry) => {
    const childAgents = entries.filter(
      (candidate) => parentAgentId(candidate.agent) === entry.agent.id,
    ).length;
    return {
      id: entry.agent.id,
      kind: "agent",
      title: title(entry),
      repo: repoLabel(entry),
      meta: `${entry.agent.provider}${entry.agent.model ? ` · ${entry.agent.model}` : ""} · ${stateLabel(entry.agent)}`,
      status: stateLabel(entry.agent),
      colorKey: placement(entry),
      messageCount: interactions?.messagesByAgent.get(entry.agent.id) ?? 0,
      childCount: childAgents,
      parentId: parentAgentId(entry.agent),
      agentId: entry.agent.id,
      entry,
      x: 0,
      y: 0,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const edgeMap = new Map<string, GraphEdge>();
  for (const node of nodes) {
    if (node.parentId && byId.has(node.parentId)) {
      mergeEdge(edgeMap, node.parentId, node.id, Math.max(1, node.messageCount), "tree", "max");
    }
  }

  const subagentNodes: GraphNode[] = [];
  if (options.includeSubagents !== false) {
    const subagents = [...(interactions?.subagents ?? [])]
      .sort((left, right) => right.count - left.count)
      .slice(0, 80);
    for (const subagent of subagents) {
      const parent = byId.get(subagent.parentId);
      if (!parent) continue;
      const id = `sub:${subagent.parentId}:${shortId(subagent.label)}`;
      const existing = byId.get(id);
      if (existing) {
        existing.messageCount += subagent.count;
        existing.meta = `${subagent.kind} · ${existing.messageCount} calls`;
        continue;
      }
      const node: GraphNode = {
        id,
        kind: "subagent",
        title: subagent.label,
        repo: `${parent.repo} · subagent`,
        meta: `${subagent.kind} · ${subagent.count} calls`,
        status: "subagent",
        colorKey: parent.colorKey,
        messageCount: subagent.count,
        childCount: 0,
        parentId: parent.id,
        agentId: null,
        entry: null,
        x: 0,
        y: 0,
      };
      subagentNodes.push(node);
      byId.set(id, node);
      parent.childCount += 1;
      mergeEdge(edgeMap, parent.id, id, subagent.count, "subagent", "max");
    }
  }
  nodes.push(...subagentNodes);

  for (const edge of interactions?.edges ?? []) {
    mergeEdge(edgeMap, edge.from, edge.to, edge.count, edge.kind, "add");
  }

  // Compact shelf layout: each project/workspace is a panel; panels wrap into
  // rows and nodes inside a panel use one or two columns. Groups stay compact
  // and readable instead of being scattered by a force simulation.
  const clusters = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const list = clusters.get(node.colorKey);
    if (list) list.push(node);
    else clusters.set(node.colorKey, [node]);
  }
  const clusterEntries = [...clusters.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const clusterSummaries: GraphCluster[] = [];
  const maxRowWidth = 1160;
  let cursorX = GRAPH_PADDING;
  let cursorY = GRAPH_PADDING;
  let shelfHeight = 0;

  for (const [key, clusterNodes] of clusterEntries) {
    clusterNodes.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "agent" ? -1 : 1;
      return left.title.localeCompare(right.title);
    });
    const columns = clusterNodes.length > 4 ? 2 : 1;
    const rows = Math.ceil(clusterNodes.length / columns);
    const panelWidth = columns * NODE_WIDTH + (columns - 1) * 16 + 32;
    const panelHeight = rows * NODE_HEIGHT + Math.max(0, rows - 1) * 12 + 32 + 28;

    if (cursorX > GRAPH_PADDING && cursorX + panelWidth > maxRowWidth) {
      cursorX = GRAPH_PADDING;
      cursorY += shelfHeight + 24;
      shelfHeight = 0;
    }

    clusterNodes.forEach((node, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      node.x = cursorX + 16 + column * (NODE_WIDTH + 16);
      node.y = cursorY + 28 + 16 + row * (NODE_HEIGHT + 12);
    });

    clusterSummaries.push({
      key,
      name: key.split(" · ")[0] || key,
      x: cursorX,
      y: cursorY,
      width: panelWidth,
      height: panelHeight,
      count: clusterNodes.length,
    });

    cursorX += panelWidth + 24;
    shelfHeight = Math.max(shelfHeight, panelHeight);
  }

  const width = Math.max(
    NODE_WIDTH + GRAPH_PADDING * 2,
    ...clusterSummaries.map((cluster) => cluster.x + cluster.width + GRAPH_PADDING),
  );
  const height = Math.max(
    NODE_HEIGHT + GRAPH_PADDING * 2,
    cursorY + shelfHeight + GRAPH_PADDING,
  );

  const finalEdges = [...edgeMap.values()].filter(
    (edge) => byId.has(edge.from) && byId.has(edge.to),
  );
  return { nodes, byId, edges: finalEdges, clusters: clusterSummaries, width, height };
}
