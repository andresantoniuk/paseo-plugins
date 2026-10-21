import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Platform, Pressable, ScrollView, Text, View } from "react-native";
import {
  buildGraph,
  edgeLabel,
  edgeThickness,
  type GraphNode,
  type InteractionData,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "./graph";
import {
  type AgentEntry,
  baseProjectName,
  bucketOf,
  type HostScope,
  hostColor,
  hostOf,
  placement,
} from "./monitor";

type GraphViewProps = {
  entries: AgentEntry[];
  hosts: readonly HostScope[];
  interactions: InteractionData | undefined;
  loading: boolean;
  theme: PluginSurfaceProps["theme"];
  navigation: PluginSurfaceProps["navigation"];
  compact: boolean;
};

const PALETTE = ["#7c9cff", "#34d399", "#fbbf24", "#f87171", "#c084fc", "#22d3ee", "#f472b6"];

function colorIndex(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % PALETTE.length;
}

function statusColor(node: GraphNode, theme: PluginSurfaceProps["theme"]): string {
  if (node.kind === "subagent") return theme.colors.foregroundMuted;
  if (node.entry) {
    const bucket = bucketOf(node.entry.agent);
    if (node.entry.agent.status === "error") return theme.colors.statusDanger;
    if (bucket === "attention") return theme.colors.statusWarning;
    if (bucket === "running") return theme.colors.statusSuccess;
  }
  return theme.colors.foregroundMuted;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function AgentGraph({
  entries,
  hosts,
  interactions,
  loading,
  theme,
  navigation,
}: GraphViewProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [hostFilter, setHostFilter] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [showSubagents, setShowSubagents] = useState(true);
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{ from: string; to: string } | null>(null);
  const [manual, setManual] = useState<Record<string, { x: number; y: number }>>({});
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<View>(null);
  const panRef = useRef(pan);
  const panStart = useRef({ x: 0, y: 0 });
  const canvasMoved = useRef(false);
  panRef.current = pan;

  useEffect(() => {
    setManual({});
    setSelectedId(null);
    setSelectedEdge(null);
  }, [hostFilter, projectFilter, workspaceFilter, providerFilter, showSubagents, connectedOnly]);

  const entryHosts = useMemo(() => {
    const byId = new Map<string, HostScope>();
    for (const entry of entries) {
      const scope = hostOf(entry);
      if (scope && !byId.has(scope.serverId)) byId.set(scope.serverId, scope);
    }
    return [...byId.values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [entries]);
  const hostChoices = entryHosts.length > 0 ? entryHosts : [...hosts];

  const projectKeys = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entries) {
      const name = baseProjectName(entry.project.projectName);
      if (name && !map.has(name)) map.set(name, placement(entry));
    }
    return map;
  }, [entries]);
  const projects = useMemo(() => [...projectKeys.keys()].sort(), [projectKeys]);
  const workspaces = useMemo(
    () =>
      [
        ...new Set(entries.map((entry) => entry.project.workspaceName?.trim()).filter(Boolean)),
      ].sort() as string[],
    [entries],
  );
  const providers = useMemo(
    () => [...new Set(entries.map((entry) => entry.agent.provider))].sort(),
    [entries],
  );
  const filteredEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (!hostFilter || hostOf(entry)?.serverId === hostFilter) &&
          (!projectFilter || baseProjectName(entry.project.projectName) === projectFilter) &&
          (!workspaceFilter || entry.project.workspaceName === workspaceFilter) &&
          (!providerFilter || entry.agent.provider === providerFilter),
      ),
    [entries, hostFilter, projectFilter, workspaceFilter, providerFilter],
  );
  const layout = useMemo(
    () => buildGraph(filteredEntries, interactions, { includeSubagents: showSubagents }),
    [filteredEntries, interactions, showSubagents],
  );

  const subagentCount = useMemo(() => {
    const ids = new Set(filteredEntries.map((entry) => entry.agent.id));
    return (interactions?.subagents ?? []).filter((subagent) => ids.has(subagent.parentId)).length;
  }, [filteredEntries, interactions]);

  const degree = useMemo(() => {
    const map = new Map<string, number>();
    for (const edge of layout.edges) {
      map.set(edge.from, (map.get(edge.from) ?? 0) + 1);
      map.set(edge.to, (map.get(edge.to) ?? 0) + 1);
    }
    return map;
  }, [layout.edges]);

  const visibleNodes = useMemo(
    () =>
      connectedOnly ? layout.nodes.filter((node) => (degree.get(node.id) ?? 0) > 0) : layout.nodes,
    [connectedOnly, degree, layout.nodes],
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleById = useMemo(
    () => new Map(visibleNodes.map((node) => [node.id, node])),
    [visibleNodes],
  );
  const visibleEdges = useMemo(
    () => layout.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)),
    [layout.edges, visibleIds],
  );
  const positionOf = useCallback(
    (node: GraphNode) => manual[node.id] ?? { x: node.x, y: node.y },
    [manual],
  );

  // Lanes stay fixed at their layout positions: a dragged card floats above
  // them instead of pulling its lane along, so lanes never overlap each other.
  const clusterBoxes = useMemo(() => {
    const groups = new Map<string, GraphNode[]>();
    for (const node of visibleNodes) {
      const list = groups.get(node.colorKey);
      if (list) list.push(node);
      else groups.set(node.colorKey, [node]);
    }
    const boxes: Array<{
      key: string;
      name: string;
      count: number;
      hosts: string[];
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    for (const [key, group] of groups) {
      let left = Number.POSITIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      const hosts = new Set<string>();
      for (const node of group) {
        if (node.host) hosts.add(node.host.label);
        left = Math.min(left, node.x);
        top = Math.max(top, node.y);
        right = Math.max(right, node.x + NODE_WIDTH);
        bottom = Math.max(bottom, node.y + NODE_HEIGHT);
      }
      if (!Number.isFinite(left)) continue;
      const pad = 20;
      const header = 30;
      boxes.push({
        key,
        name: key.split(" · ")[0] || key,
        count: group.length,
        hosts: [...hosts].sort(),
        x: left - pad,
        y: top - header - pad,
        width: right - left + pad * 2,
        height: bottom - top + pad * 2 + header,
      });
    }
    return boxes.sort((left, right) => left.name.localeCompare(right.name));
  }, [visibleNodes]);

  const focusIds = useMemo(() => {
    if (selectedEdge) return new Set([selectedEdge.from, selectedEdge.to]);
    if (!selectedId) return null;
    const ids = new Set<string>([selectedId]);
    for (const edge of visibleEdges) {
      if (edge.from === selectedId) ids.add(edge.to);
      if (edge.to === selectedId) ids.add(edge.from);
    }
    return ids;
  }, [selectedEdge, selectedId, visibleEdges]);

  const focusedClusterKeys = useMemo(() => {
    if (!focusIds) return null;
    const keys = new Set<string>();
    for (const node of visibleNodes) {
      if (focusIds.has(node.id)) keys.add(node.colorKey);
    }
    return keys;
  }, [focusIds, visibleNodes]);

  const selectedEdgeNodes = useMemo(() => {
    if (!selectedEdge) return null;
    const from = visibleById.get(selectedEdge.from);
    const to = visibleById.get(selectedEdge.to);
    if (!from || !to) return null;
    const edge = visibleEdges.find(
      (candidate) => candidate.from === selectedEdge.from && candidate.to === selectedEdge.to,
    );
    return edge ? { edge, from, to } : null;
  }, [selectedEdge, visibleById, visibleEdges]);

  const selected = selectedId ? (visibleById.get(selectedId) ?? null) : null;

  useEffect(() => {
    if (selectedId && !visibleById.has(selectedId)) setSelectedId(null);
    if (
      selectedEdge &&
      !visibleEdges.some((edge) => edge.from === selectedEdge.from && edge.to === selectedEdge.to)
    ) {
      setSelectedEdge(null);
    }
  }, [selectedEdge, selectedId, visibleById, visibleEdges]);

  const moveNode = useCallback((id: string, position: { x: number; y: number }) => {
    setManual((current) => ({ ...current, [id]: position }));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setSelectedEdge(null);
  }, []);

  const selectNode = useCallback((id: string) => {
    setSelectedEdge(null);
    setSelectedId((current) => (current === id ? null : id));
  }, []);

  const selectEdge = useCallback((from: string, to: string) => {
    setSelectedId(null);
    setSelectedEdge((current) =>
      current?.from === from && current?.to === to ? null : { from, to },
    );
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const next = clamp(scale * factor, 0.3, 2.5);
      const ratio = next / scale;
      setPan((current) => ({
        x: viewport.width / 2 - (viewport.width / 2 - current.x) * ratio,
        y: viewport.height / 2 - (viewport.height / 2 - current.y) * ratio,
      }));
      setScale(next);
    },
    [scale, viewport.height, viewport.width],
  );

  const fit = useCallback(() => {
    if (!viewport.width || !viewport.height || !layout.width || !layout.height) return;
    const next = clamp(
      Math.min((viewport.width - 40) / layout.width, (viewport.height - 40) / layout.height),
      0.3,
      1.4,
    );
    setScale(next);
    setPan({
      x: (viewport.width - layout.width * next) / 2,
      y: (viewport.height - layout.height * next) / 2,
    });
    setManual({});
  }, [layout.height, layout.width, viewport.height, viewport.width]);

  const resetView = useCallback(() => {
    setSelectedId(null);
    setSelectedEdge(null);
    setManual({});
    setScale(1);
    setPan({ x: 0, y: 0 });
    setHostFilter(null);
    setProjectFilter(null);
    setWorkspaceFilter(null);
    setProviderFilter(null);
    setShowSubagents(true);
    setConnectedOnly(false);
  }, []);

  const handleWheel = useCallback(
    (event: unknown) => {
      const wheel = event as {
        preventDefault?: () => void;
        deltaY?: number;
        ctrlKey?: boolean;
      };
      wheel.preventDefault?.();
      const delta = Number(wheel.deltaY ?? 0);
      if (!Number.isFinite(delta) || delta === 0) return;
      // Trackpad pinch arrives as a ctrl+wheel with small deltas.
      const intensity = wheel.ctrlKey ? 0.012 : 0.003;
      zoomBy(Math.exp(-delta * intensity));
    },
    [zoomBy],
  );

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = canvasRef.current as unknown as {
      addEventListener?: (
        name: string,
        handler: (event: unknown) => void,
        options?: unknown,
      ) => void;
      removeEventListener?: (name: string, handler: (event: unknown) => void) => void;
    } | null;
    if (!node?.addEventListener || !node.removeEventListener) return;
    const listener = (event: unknown) => handleWheel(event);
    node.addEventListener("wheel", listener, { passive: false });
    return () => node.removeEventListener?.("wheel", listener);
  }, [handleWheel]);

  const canvasPan = useMemo(
    () =>
      PanResponder.create({
        // Claim taps too, so a click on empty canvas clears the focus.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3,
        onPanResponderGrant: () => {
          panStart.current = panRef.current;
          canvasMoved.current = false;
        },
        onPanResponderMove: (_event, gesture) => {
          if (Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3) canvasMoved.current = true;
          setPan({ x: panStart.current.x + gesture.dx, y: panStart.current.y + gesture.dy });
        },
        onPanResponderRelease: () => {
          if (!canvasMoved.current) clearSelection();
        },
      }),
    [clearSelection],
  );

  const activeFilterCount =
    (hostFilter ? 1 : 0) +
    (projectFilter ? 1 : 0) +
    (workspaceFilter ? 1 : 0) +
    (providerFilter ? 1 : 0) +
    (showSubagents ? 0 : 1) +
    (connectedOnly ? 1 : 0);

  if (entries.length === 0) {
    return (
      <View style={{ padding: 20 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          No agents match this filter.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border + "66",
          paddingVertical: 7,
          gap: 6,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 14,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={filtersOpen ? "Hide filters" : "Show filters"}
            onPress={() => setFiltersOpen((value) => !value)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              minHeight: 26,
              paddingHorizontal: 8,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <Icon
              name={filtersOpen ? "ChevronDown" : "ChevronRight"}
              size={12}
              color={theme.colors.foregroundMuted}
            />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
            </Text>
          </Pressable>
          <Chip label="Fit" active={false} theme={theme} onPress={fit} />
          <ZoomButton label="−" theme={theme} onPress={() => zoomBy(1 / 1.2)} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, minWidth: 34 }}>
            {Math.round(scale * 100)}%
          </Text>
          <ZoomButton label="+" theme={theme} onPress={() => zoomBy(1.2)} />
          <Pressable onPress={resetView} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Reset</Text>
          </Pressable>
          {loading ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              reading timelines…
            </Text>
          ) : interactions?.unreadable ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 10 }}>
              {interactions.unreadable} timelines unreadable
            </Text>
          ) : null}
        </View>
        {filtersOpen ? (
          <>
            {hostChoices.length > 1 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 6, paddingHorizontal: 14 }}
              >
                <Chip
                  label="All hosts"
                  active={hostFilter === null}
                  theme={theme}
                  onPress={() => setHostFilter(null)}
                />
                {hostChoices.map((host) => (
                  <Chip
                    key={host.serverId}
                    label={host.label}
                    active={hostFilter === host.serverId}
                    theme={theme}
                    onPress={() =>
                      setHostFilter(hostFilter === host.serverId ? null : host.serverId)
                    }
                  />
                ))}
              </ScrollView>
            ) : null}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 6, paddingHorizontal: 14 }}
            >
              <Chip
                label="All projects"
                active={projectFilter === null}
                theme={theme}
                onPress={() => setProjectFilter(null)}
              />
              {projects.map((project) => (
                <Chip
                  key={project}
                  label={project}
                  color={PALETTE[colorIndex(projectKeys.get(project) ?? project)]}
                  active={projectFilter === project}
                  theme={theme}
                  onPress={() => setProjectFilter(projectFilter === project ? null : project)}
                />
              ))}
            </ScrollView>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 6, paddingHorizontal: 14 }}
            >
              <Chip
                label="All workspaces"
                active={workspaceFilter === null}
                theme={theme}
                onPress={() => setWorkspaceFilter(null)}
              />
              {workspaces.map((workspace) => (
                <Chip
                  key={workspace}
                  label={workspace}
                  active={workspaceFilter === workspace}
                  theme={theme}
                  onPress={() =>
                    setWorkspaceFilter(workspaceFilter === workspace ? null : workspace)
                  }
                />
              ))}
            </ScrollView>
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 14,
              }}
            >
              <Chip
                label="All providers"
                active={providerFilter === null}
                theme={theme}
                onPress={() => setProviderFilter(null)}
              />
              {providers.map((provider) => (
                <Chip
                  key={provider}
                  label={provider}
                  active={providerFilter === provider}
                  theme={theme}
                  onPress={() => setProviderFilter(providerFilter === provider ? null : provider)}
                />
              ))}
              <Chip
                label={`Subagents ${subagentCount}`}
                active={showSubagents}
                theme={theme}
                onPress={() => setShowSubagents((value) => !value)}
              />
              <Chip
                label="Connected only"
                active={connectedOnly}
                theme={theme}
                onPress={() => setConnectedOnly((value) => !value)}
              />
            </View>
          </>
        ) : null}
      </View>

      <View
        style={{ flex: 1, overflow: "hidden" }}
        onLayout={(event) =>
          setViewport({
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height,
          })
        }
        ref={canvasRef}
      >
        <View
          style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}
          {...canvasPan.panHandlers}
        />
        <View
          style={{
            width: layout.width,
            height: layout.height,
            transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale }],
            transformOrigin: "left top",
            pointerEvents: "box-none",
          }}
        >
          {clusterBoxes.map((cluster) => {
            const color = PALETTE[colorIndex(cluster.key)];
            const clusterDimmed =
              focusedClusterKeys !== null && !focusedClusterKeys.has(cluster.key);
            return (
              <View
                key={cluster.key}
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: cluster.x,
                  top: cluster.y,
                  width: cluster.width,
                  height: cluster.height,
                  borderRadius: 16,
                  backgroundColor: color + "10",
                  borderWidth: 1,
                  borderColor: color + "33",
                  opacity: clusterDimmed ? 0.18 : 1,
                }}
              >
                <Text
                  style={{
                    position: "absolute",
                    left: 12,
                    top: 8,
                    color,
                    fontSize: 11,
                    fontWeight: "700",
                  }}
                >
                  {cluster.name} · {cluster.count}
                  {cluster.hosts.length > 1 ? ` · ${cluster.hosts.join(", ")}` : ""}
                </Text>
              </View>
            );
          })}

          {visibleEdges.map((edge) => {
            const from = visibleById.get(edge.from);
            const to = visibleById.get(edge.to);
            if (!from || !to) return null;
            const a = positionOf(from);
            const b = positionOf(to);
            // Center to center: the line is drawn behind the cards, so it
            // appears to emerge from each card's middle.
            const x1 = a.x + NODE_WIDTH / 2;
            const y1 = a.y + NODE_HEIGHT / 2;
            const x2 = b.x + NODE_WIDTH / 2;
            const y2 = b.y + NODE_HEIGHT / 2;
            const dx = x2 - x1;
            const dy = y2 - y1;
            const length = Math.hypot(dx, dy);
            const angle = Math.atan2(dy, dx);
            const thickness = edgeThickness(edge.count);
            const edgeSelected =
              selectedEdge !== null &&
              edge.from === selectedEdge.from &&
              edge.to === selectedEdge.to;
            const active = selectedEdge
              ? edgeSelected
              : selectedId
                ? edge.from === selectedId || edge.to === selectedId
                : true;
            const color = edgeSelected
              ? theme.colors.accent
              : edge.kind === "message"
                ? theme.colors.accent
                : edge.kind === "subagent"
                  ? theme.colors.statusWarning
                  : theme.colors.border;
            const hitHeight = Math.max(12, thickness);
            return (
              <Pressable
                key={`${edge.from}>${edge.to}`}
                accessibilityRole="button"
                accessibilityLabel={`Select connection from ${from.title} to ${to.title}`}
                onPress={() => selectEdge(edge.from, edge.to)}
                style={{
                  position: "absolute",
                  left: x1,
                  top: y1 - hitHeight / 2,
                  width: length,
                  height: hitHeight,
                  justifyContent: "center",
                  transform: [{ rotate: `${angle}rad` }],
                  transformOrigin: "left center",
                  ...(Platform.OS === "web" ? { cursor: "pointer" } : null),
                }}
              >
                <View
                  style={{
                    height: edgeSelected ? thickness + 2 : thickness,
                    borderRadius: thickness / 2,
                    backgroundColor: color,
                    opacity: active ? (edgeSelected ? 1 : edge.kind === "tree" ? 0.7 : 0.85) : 0.06,
                  }}
                />
              </Pressable>
            );
          })}

          {visibleEdges.map((edge) => {
            const label = edgeLabel(edge.count);
            if (!label) return null;
            const from = visibleById.get(edge.from);
            const to = visibleById.get(edge.to);
            if (!from || !to) return null;
            const a = positionOf(from);
            const b = positionOf(to);
            const x = (a.x + b.x + NODE_WIDTH) / 2;
            const y = (a.y + b.y + NODE_HEIGHT) / 2;
            const edgeSelected =
              selectedEdge !== null &&
              edge.from === selectedEdge.from &&
              edge.to === selectedEdge.to;
            const active = selectedEdge
              ? edgeSelected
              : selectedId
                ? edge.from === selectedId || edge.to === selectedId
                : true;
            return (
              <Pressable
                key={`label-${edge.from}>${edge.to}`}
                accessibilityRole="button"
                accessibilityLabel={`Select connection from ${from.title} to ${to.title}`}
                onPress={() => selectEdge(edge.from, edge.to)}
                style={{
                  position: "absolute",
                  left: x - 12,
                  top: y - 10,
                  minWidth: 24,
                  paddingHorizontal: 4,
                  paddingVertical: 1,
                  borderRadius: 8,
                  backgroundColor: theme.colors.surface0,
                  borderWidth: 1,
                  borderColor: edgeSelected ? theme.colors.accent : theme.colors.border + "66",
                  alignItems: "center",
                  opacity: active ? 1 : 0.25,
                  ...(Platform.OS === "web" ? { cursor: "pointer" } : null),
                }}
              >
                <Text
                  style={{
                    color: edgeSelected ? theme.colors.accent : theme.colors.foregroundMuted,
                    fontSize: 9,
                  }}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}

          {visibleNodes.map((node) => {
            const position = positionOf(node);
            const dimmed = focusIds !== null && !focusIds.has(node.id);
            const edgeEndpoint =
              selectedEdge !== null &&
              (selectedEdge.from === node.id || selectedEdge.to === node.id);
            const lifted = manual[node.id] !== undefined || selectedId === node.id;
            return (
              <GraphNodeView
                key={node.id}
                node={node}
                position={position}
                scale={scale}
                dimmed={dimmed}
                lifted={lifted}
                selected={selectedId === node.id || edgeEndpoint}
                theme={theme}
                onSelect={selectNode}
                onMove={moveNode}
              />
            );
          })}
        </View>

        {selected ? (
          <View
            style={{
              position: "absolute",
              left: 16,
              right: 16,
              bottom: 16,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: theme.colors.border + "88",
              borderRadius: 10,
              padding: 12,
              gap: 3,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 5,
                  backgroundColor: statusColor(selected, theme),
                }}
              />
              <Text
                numberOfLines={1}
                style={{ flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "700" }}
              >
                {selected.title}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                {selected.kind}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close graph details"
                onPress={() => setSelectedId(null)}
                style={{ padding: 4 }}
              >
                <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
              </Pressable>
            </View>
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {selected.repo}
            </Text>
            {selected.host ? (
              <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {selected.host.label}
              </Text>
            ) : null}
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {selected.meta} · {selected.messageCount} messages
              {selected.childCount > 0 ? ` · ${selected.childCount} children` : ""}
            </Text>
            {selected.agentId ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open agent ${selected.title}`}
                onPress={() =>
                  navigation?.openAgent({
                    agentId: selected.agentId ?? "",
                    ...(selected.host ? { serverId: selected.host.serverId } : null),
                  })
                }
                style={{
                  alignSelf: "flex-start",
                  marginTop: 4,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  borderRadius: 6,
                  backgroundColor: theme.colors.accent,
                }}
              >
                <Text
                  style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "600" }}
                >
                  Open agent
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {selectedEdgeNodes ? (
          <View
            style={{
              position: "absolute",
              left: 16,
              right: 16,
              bottom: 16,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: theme.colors.accent + "88",
              borderRadius: 10,
              padding: 12,
              gap: 3,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon name="GitBranch" size={14} color={theme.colors.accent} />
              <Text
                style={{
                  flex: 1,
                  color: theme.colors.foreground,
                  fontSize: 13,
                  fontWeight: "700",
                }}
              >
                {selectedEdgeNodes.edge.kind === "message"
                  ? "Message link"
                  : selectedEdgeNodes.edge.kind === "subagent"
                    ? "Subagent link"
                    : "Hierarchy link"}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                {selectedEdgeNodes.edge.count}{" "}
                {selectedEdgeNodes.edge.count === 1 ? "message" : "messages"}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close connection details"
                onPress={() => setSelectedEdge(null)}
                style={{ padding: 4 }}
              >
                <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
              </Pressable>
            </View>
            <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {selectedEdgeNodes.from.title} ↔ {selectedEdgeNodes.to.title}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Chip({
  label,
  active,
  color,
  theme,
  onPress,
}: {
  label: string;
  active: boolean;
  color?: string;
  theme: PluginSurfaceProps["theme"];
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        maxWidth: 190,
        minHeight: 26,
        paddingHorizontal: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
      }}
    >
      {color ? (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      ) : null}
      <Text
        numberOfLines={1}
        style={{
          color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted,
          fontSize: 11,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ZoomButton({
  label,
  theme,
  onPress,
}: {
  label: string;
  theme: PluginSurfaceProps["theme"];
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label === "+" ? "Zoom in" : "Zoom out"}
      onPress={onPress}
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function GraphNodeView({
  node,
  position,
  scale,
  dimmed,
  lifted,
  selected,
  theme,
  onSelect,
  onMove,
}: {
  node: GraphNode;
  position: { x: number; y: number };
  scale: number;
  dimmed: boolean;
  lifted: boolean;
  selected: boolean;
  theme: PluginSurfaceProps["theme"];
  onSelect: (id: string) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
}) {
  const start = useRef({ x: 0, y: 0 });
  const moved = useRef(false);
  const positionRef = useRef(position);
  const scaleRef = useRef(scale);
  positionRef.current = position;
  scaleRef.current = scale;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3,
        onPanResponderGrant: () => {
          start.current = positionRef.current;
          moved.current = false;
        },
        onPanResponderMove: (_event, gesture) => {
          if (Math.abs(gesture.dx) <= 3 && Math.abs(gesture.dy) <= 3) return;
          moved.current = true;
          const next = {
            x: start.current.x + gesture.dx / scaleRef.current,
            y: start.current.y + gesture.dy / scaleRef.current,
          };
          onMove(node.id, next);
        },
        onPanResponderRelease: () => {
          if (!moved.current) onSelect(node.id);
        },
      }),
    [node.id, onMove, onSelect],
  );

  const border = selected
    ? theme.colors.accent
    : node.kind === "subagent"
      ? theme.colors.statusWarning + "88"
      : PALETTE[colorIndex(node.colorKey)] + "88";

  return (
    <View
      {...responder.panHandlers}
      accessibilityRole="button"
      accessibilityLabel={`Select ${node.title}`}
      style={{
        position: "absolute",
        left: position.x,
        top: position.y,
        width: NODE_WIDTH,
        zIndex: lifted ? 10 : 1,
        minHeight: NODE_HEIGHT,
        padding: 9,
        borderRadius: 10,
        borderWidth: selected ? 2 : 1,
        borderStyle: node.kind === "subagent" ? "dashed" : "solid",
        borderColor: border,
        backgroundColor: theme.colors.surface1,
        opacity: dimmed ? 0.12 : 1,
        gap: 2,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: statusColor(node, theme),
          }}
        />
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={{ flex: 1, color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}
        >
          {node.title}
        </Text>
        {node.host ? (
          <View
            accessibilityLabel={`Host ${node.host.label}`}
            style={{
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: 7,
              borderWidth: 1,
              borderColor: `${hostColor(node.host)}66`,
              backgroundColor: `${hostColor(node.host)}26`,
            }}
          >
            <Text style={{ color: hostColor(node.host), fontSize: 9, fontWeight: "700" }}>
              {node.host.label}
            </Text>
          </View>
        ) : null}
        {node.kind === "subagent" ? (
          <Icon name="Bot" size={12} color={theme.colors.statusWarning} />
        ) : null}
      </View>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
        {node.repo}
      </Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
        {node.meta}
        {node.messageCount > 0 ? ` · ${node.messageCount} msgs` : ""}
      </Text>
      {node.childCount > 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>
          {node.childCount} {node.childCount === 1 ? "child" : "children"}
        </Text>
      ) : null}
    </View>
  );
}
