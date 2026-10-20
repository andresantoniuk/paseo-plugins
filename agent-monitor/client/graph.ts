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

export type GraphLayout = {
  nodes: GraphNode[];
  byId: Map<string, GraphNode>;
  edges: GraphEdge[];
  width: number;
  height: number;
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
 * A force-directed layout for agents and their provider subagents.
 *
 * Paseo agents and provider-native subagents live in different universes: the
 * former have `parentAgentId`, the latter only appear as `Task`/`Agent` tool
 * calls in a timeline. Both are nodes here, with the invocation count as the
 * edge weight. Agents with no relationships still spread over the canvas.
 */
export function buildGraph(
  entries: readonly AgentEntry[],
  interactions: InteractionData | undefined,
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
      mergeEdge(
        edgeMap,
        node.parentId,
        node.id,
        Math.max(1, node.messageCount),
        "tree",
        "max",
      );
    }
  }

  // Provider-native subagents become leaf nodes, one per distinct task label.
  const subagentNodes: GraphNode[] = [];
  const subagents = [...(interactions?.subagents ?? [])]
    .sort((left, right) => right.count - left.count)
    .slice(0, 80);
  for (const subagent of subagents) {
    const parent = byId.get(subagent.parentId);
    if (!parent) continue;
    const id = `sub:${subagent.parentId}:${shortId(subagent.label)}`;
    if (byId.has(id)) {
      const existing = byId.get(id);
      if (existing) {
        existing.messageCount += subagent.count;
        existing.meta = `${subagent.kind} · ${existing.messageCount} calls`;
      }
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
  nodes.push(...subagentNodes);

  for (const edge of interactions?.edges ?? []) {
    mergeEdge(edgeMap, edge.from, edge.to, edge.count, edge.kind, "add");
  }

  // Deterministic initial ring, then a force simulation with repulsion and
  // edge attraction. Provider subagents start near their parent.
  const positions = new Map<string, { x: number; y: number }>();
  const total = Math.max(1, nodes.length);
  nodes.forEach((node, index) => {
    const angle = (index / total) * Math.PI * 2;
    const radius = 140 + Math.sqrt(total) * 70;
    positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  for (const node of subagentNodes) {
    if (!node.parentId) continue;
    const parent = positions.get(node.parentId);
    if (!parent) continue;
    positions.set(node.id, { x: parent.x + 120, y: parent.y + 60 });
  }

  const nodeList = [...byId.values()];
  const ideal = NODE_WIDTH + 80;
  for (let iteration = 0; iteration < 180; iteration += 1) {
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
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const weight = 1 + Math.min(2, Math.log2(edge.count + 1) * 0.6);
      const force = ((distance * distance) / ideal) * weight * 0.5;
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

    const temperature = 0.12 * (1 - iteration / 180) + 0.015;
    for (const node of nodeList) {
      const position = positions.get(node.id);
      const delta = displacement.get(node.id);
      if (!position || !delta) continue;
      delta.x -= position.x * 0.012;
      delta.y -= position.y * 0.012;
      const length = Math.hypot(delta.x, delta.y) || 1;
      const step = Math.min(length, temperature * 60);
      position.x += (delta.x / length) * step;
      position.y += (delta.y / length) * step;
    }
  }

  // Shift the cloud into positive coordinates and normalize the canvas.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const position of positions.values()) {
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
  }
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodeList) {
    const position = positions.get(node.id);
    if (!position) continue;
    node.x = position.x - minX + GRAPH_PADDING;
    node.y = position.y - minY + GRAPH_PADDING;
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }

  return {
    nodes: nodeList,
    byId,
    edges: [...edgeMap.values()],
    width: Math.max(NODE_WIDTH + GRAPH_PADDING * 2, maxX + NODE_WIDTH + GRAPH_PADDING),
    height: Math.max(NODE_HEIGHT + GRAPH_PADDING * 2, maxY + NODE_HEIGHT + GRAPH_PADDING),
  };
}
