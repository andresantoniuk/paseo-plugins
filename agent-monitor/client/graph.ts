import type { AgentEntry } from "./monitor";
import { parentAgentId, placement, title } from "./monitor";

export type GraphEdgeKind = "tree" | "message";

export type GraphEdge = {
  from: string;
  to: string;
  count: number;
  kind: GraphEdgeKind;
};

/** Timeline-derived interaction data: messages per agent and directed message counts. */
export type InteractionData = {
  messagesByAgent: ReadonlyMap<string, number>;
  edges: readonly GraphEdge[];
};

export type GraphNode = {
  entry: AgentEntry;
  depth: number;
  row: number;
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

export const NODE_WIDTH = 250;
export const NODE_HEIGHT = 86;
export const COLUMN_GAP = 64;
export const ROW_GAP = 26;
export const GRAPH_PADDING = 24;

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
  return 1 + Math.min(5, Math.log2(Math.max(1, count) + 1) * 1.6);
}

export function edgeLabel(count: number): string {
  return count > 1 ? String(count) : "";
}

/**
 * Builds a layered tree of agents and merges the timeline-derived edges into it.
 *
 * Parent-child edges come from `parentAgentId` and always exist. Message edges
 * add the agents that talked to each other without a parent relationship. The
 * weight is the number of messages observed on the tail of each timeline.
 */
export function buildGraph(
  entries: readonly AgentEntry[],
  interactions: InteractionData | undefined,
): GraphLayout {
  const byId = new Map(entries.map((entry) => [entry.agent.id, entry]));
  const children = new Map<string, AgentEntry[]>();
  const roots: AgentEntry[] = [];

  for (const entry of entries) {
    const parent = parentAgentId(entry.agent);
    if (parent && parent !== entry.agent.id && byId.has(parent)) {
      const list = children.get(parent);
      if (list) list.push(entry);
      else children.set(parent, [entry]);
    } else {
      roots.push(entry);
    }
  }
  for (const list of children.values()) {
    list.sort((left, right) => title(left).localeCompare(title(right)));
  }
  roots.sort(
    (left, right) =>
      placement(left).localeCompare(placement(right)) || title(left).localeCompare(title(right)),
  );

  const depthById = new Map<string, number>();
  const rowById = new Map<string, number>();
  const visited = new Set<string>();
  let nextRow = 0;

  const visit = (entry: AgentEntry, depth: number): number => {
    const known = rowById.get(entry.agent.id);
    if (known !== undefined) return known;
    if (visited.has(entry.agent.id)) return nextRow;
    visited.add(entry.agent.id);
    depthById.set(entry.agent.id, depth);

    const kids = children.get(entry.agent.id) ?? [];
    let row: number;
    if (kids.length === 0) {
      row = nextRow++;
    } else {
      const rows = kids.map((kid) => visit(kid, depth + 1));
      row = (rows[0] + rows[rows.length - 1]) / 2;
    }
    rowById.set(entry.agent.id, row);
    return row;
  };

  for (const root of roots) visit(root, 0);
  // Malformed parent cycles or parents filtered out: never drop a node.
  for (const entry of entries) {
    if (!visited.has(entry.agent.id)) visit(entry, 0);
  }

  const nodes: GraphNode[] = entries.map((entry) => {
    const depth = depthById.get(entry.agent.id) ?? 0;
    const row = rowById.get(entry.agent.id) ?? 0;
    return {
      entry,
      depth,
      row,
      x: GRAPH_PADDING + depth * (NODE_WIDTH + COLUMN_GAP),
      y: GRAPH_PADDING + row * (NODE_HEIGHT + ROW_GAP),
    };
  });
  const byGraphId = new Map(nodes.map((node) => [node.entry.agent.id, node]));

  const edgeMap = new Map<string, GraphEdge>();
  const addEdge = (
    from: string,
    to: string,
    count: number,
    kind: GraphEdgeKind,
    mode: "add" | "max",
  ) => {
    if (!byId.has(from) || !byId.has(to) || from === to) return;
    const key = `${from}>${to}`;
    const existing = edgeMap.get(key);
    if (!existing) {
      edgeMap.set(key, { from, to, count, kind });
      return;
    }
    existing.count = mode === "max" ? Math.max(existing.count, count) : existing.count + count;
    if (kind === "message") existing.kind = "message";
  };

  for (const entry of entries) {
    const parent = parentAgentId(entry.agent);
    if (parent && parent !== entry.agent.id && byId.has(parent)) {
      addEdge(
        parent,
        entry.agent.id,
        Math.max(1, interactions?.messagesByAgent.get(entry.agent.id) ?? 1),
        "tree",
        "max",
      );
    }
  }
  for (const edge of interactions?.edges ?? []) {
    addEdge(edge.from, edge.to, edge.count, edge.kind, "add");
  }

  const width = Math.max(
    NODE_WIDTH + GRAPH_PADDING * 2,
    ...nodes.map((node) => node.x + NODE_WIDTH + GRAPH_PADDING),
  );
  const height = Math.max(
    NODE_HEIGHT + GRAPH_PADDING * 2,
    ...nodes.map((node) => node.y + NODE_HEIGHT + GRAPH_PADDING),
  );

  return { nodes, byId: byGraphId, edges: [...edgeMap.values()], width, height };
}
