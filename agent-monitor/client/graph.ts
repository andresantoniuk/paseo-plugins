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

  // One cluster per project/workspace, arranged on a ring. Nodes start on a
  // smaller ring around their cluster and are then pulled toward it.
  const clusters = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const list = clusters.get(node.colorKey);
    if (list) list.push(node);
    else clusters.set(node.colorKey, [node]);
  }
  const clusterKeys = [...clusters.keys()].sort();
  const clusterCenters = new Map<string, { x: number; y: number }>();
  const columns = Math.max(1, Math.ceil(Math.sqrt(clusterKeys.length)));
  const columnGap = NODE_WIDTH * 2 + 180;
  const rowGap = NODE_HEIGHT * 3 + 140;
  clusterKeys.forEach((key, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    clusterCenters.set(key, { x: column * columnGap, y: row * rowGap });
  });

  const positions = new Map<string, { x: number; y: number }>();
  for (const [key, clusterNodes] of clusters) {
    const center = clusterCenters.get(key);
    if (!center) continue;
    clusterNodes.forEach((node, index) => {
      const angle = (index / Math.max(1, clusterNodes.length)) * Math.PI * 2;
      const radius = 70 + Math.sqrt(clusterNodes.length) * 22;
      positions.set(node.id, {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      });
    });
  }

  const nodeList = [...byId.values()];
  const ideal = NODE_WIDTH + 90;
  for (let iteration = 0; iteration < 220; iteration += 1) {
    const displacement = new Map(nodeList.map((node) => [node.id, { x: 0, y: 0 }]));

    for (let left = 0; left < nodeList.length; left += 1) {
      for (let right = left + 1; right < nodeList.length; right += 1) {
        const a = positions.get(nodeList[left].id);
        const b = positions.get(nodeList[right].id);
        if (!a || !b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = (left % 2 === 0 ? 1 : -1) * 0.5;
          dy = (right % 2 === 0 ? 1 : -1) * 0.5;
          distance = 0.7;
        }
        const force = (ideal * ideal) / distance;
        const ux = dx / distance;
        const uy = dy / distance;
        const da = displacement.get(nodeList[left].id);
        const db = displacement.get(nodeList[right].id);
        if (da) {
          da.x += ux * force;
          da.y += uy * force;
        }
        if (db) {
          db.x -= ux * force;
          db.y -= uy * force;
        }
      }
    }

    for (const edge of edgeMap.values()) {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const weight = 1 + Math.min(2, Math.log2(edge.count + 1) * 0.6);
      const force = ((distance * distance) / ideal) * weight * 0.35;
      const ux = dx / distance;
      const uy = dy / distance;
      const da = displacement.get(edge.from);
      const db = displacement.get(edge.to);
      if (da) {
        da.x -= ux * force;
        da.y -= uy * force;
      }
      if (db) {
        db.x += ux * force;
        db.y += uy * force;
      }
    }

    for (const node of nodeList) {
      const position = positions.get(node.id);
      const center = clusterCenters.get(node.colorKey);
      const delta = displacement.get(node.id);
      if (!position || !center || !delta) continue;
      delta.x += (center.x - position.x) * 0.075;
      delta.y += (center.y - position.y) * 0.075;
    }

    const temperature = 0.12 * (1 - iteration / 220) + 0.012;
    for (const node of nodeList) {
      const position = positions.get(node.id);
      const delta = displacement.get(node.id);
      if (!position || !delta) continue;
      const length = Math.hypot(delta.x, delta.y) || 1;
      const step = Math.min(length, temperature * 60);
      position.x += (delta.x / length) * step;
      position.y += (delta.y / length) * step;
    }
  }

  // Resolve hard overlaps so cards stay readable even in dense clusters.
  for (let pass = 0; pass < 16; pass += 1) {
    for (let left = 0; left < nodeList.length; left += 1) {
      for (let right = left + 1; right < nodeList.length; right += 1) {
        const a = positions.get(nodeList[left].id);
        const b = positions.get(nodeList[right].id);
        if (!a || !b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const overlapX = NODE_WIDTH + 18 - Math.abs(dx);
        const overlapY = NODE_HEIGHT + 18 - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapX < overlapY) {
          const push = (overlapX / 2) * (dx >= 0 ? 1 : -1);
          a.x += push;
          b.x -= push;
        } else {
          const push = (overlapY / 2) * (dy >= 0 ? 1 : -1);
          a.y += push;
          b.y -= push;
        }
      }
    }
  }

  // Shift the cloud into positive coordinates.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const position of positions.values()) {
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
  }
  for (const node of nodeList) {
    const position = positions.get(node.id);
    if (!position) continue;
    node.x = position.x - minX + GRAPH_PADDING;
    node.y = position.y - minY + GRAPH_PADDING;
  }

  const clusterSummaries: GraphCluster[] = [];
  for (const [key, clusterNodes] of clusters) {
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const node of clusterNodes) {
      left = Math.min(left, node.x);
      top = Math.min(top, node.y);
      right = Math.max(right, node.x + NODE_WIDTH);
      bottom = Math.max(bottom, node.y + NODE_HEIGHT);
    }
    if (!Number.isFinite(left)) continue;
    const pad = 20;
    const header = 30;
    clusterSummaries.push({
      key,
      name: key.split(" · ")[0] || key,
      x: left - pad,
      y: top - header - pad,
      width: right - left + pad * 2,
      height: bottom - top + pad * 2 + header,
      count: clusterNodes.length,
    });
  }

  const width = Math.max(
    NODE_WIDTH + GRAPH_PADDING * 2,
    ...clusterSummaries.map((cluster) => cluster.x + cluster.width + GRAPH_PADDING),
  );
  const height = Math.max(
    NODE_HEIGHT + GRAPH_PADDING * 2,
    ...clusterSummaries.map((cluster) => cluster.y + cluster.height + GRAPH_PADDING),
  );

  const finalEdges = [...edgeMap.values()].filter(
    (edge) => byId.has(edge.from) && byId.has(edge.to),
  );
  return { nodes: nodeList, byId, edges: finalEdges, clusters: clusterSummaries, width, height };
}
