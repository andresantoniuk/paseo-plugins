import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { createPressGuard, isDrag } from "./gesture";
import {
  buildClusterBoxes,
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
import { onWheel, type WheelInput } from "./web";

type GraphViewProps = {
  entries: AgentEntry[];
  hosts: readonly HostScope[];
  /**
   * An agent id to select when the graph mounts (deep link from the sidebar
   * quick access). Later selections are the user's own.
   */
  focusedAgentId?: string | null;
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

const CONTROL_MIN_COMPACT = 44;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function AgentGraph({
  entries,
  hosts,
  focusedAgentId,
  interactions,
  loading,
  theme,
  navigation,
  compact,
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
  const [canvas, setCanvas] = useState<View | null>(null);
  const panRef = useRef(pan);
  const panStart = useRef({ x: 0, y: 0 });
  const canvasGuard = useMemo(createPressGuard, []);
  panRef.current = pan;

  // The filter reset also runs on mount; skip that run so a deep-link
  // selection made on the same commit survives.
  const filtersMounted = useRef(false);
  useEffect(() => {
    if (!filtersMounted.current) {
      filtersMounted.current = true;
      return;
    }
    setManual({});
    setSelectedId(null);
    setSelectedEdge(null);
  }, [hostFilter, projectFilter, workspaceFilter, providerFilter, showSubagents, connectedOnly]);

  useEffect(() => {
    if (!focusedAgentId) return;
    setSelectedEdge(null);
    setSelectedId(focusedAgentId);
  }, [focusedAgentId]);

  // From the online hosts, not the filtered entries: a bucket filter that
  // empties one host must not hide the row that clears its host filter.
  const hostChoices = useMemo(
    () => [...hosts].sort((left, right) => left.label.localeCompare(right.label)),
    [hosts],
  );

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
    () =>
      buildGraph(filteredEntries, interactions, hostFilter ?? hosts[0]?.serverId ?? "", {
        includeSubagents: showSubagents,
      }),
    [filteredEntries, hostFilter, hosts, interactions, showSubagents],
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

  // The halo follows the cards, so dragging a node never leaves its group
  // visually behind. It grows and shrinks with the members.
  const clusterBoxes = useMemo(
    () => buildClusterBoxes(visibleNodes, positionOf),
    [positionOf, visibleNodes],
  );

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
    // Wait for nodes: a deep-link selection made while entries load must survive.
    if (visibleById.size === 0) return;
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
    (event: WheelInput) => {
      event.preventDefault?.();
      const delta = Number(event.deltaY ?? 0);
      if (!Number.isFinite(delta) || delta === 0) return;
      // Trackpad pinch arrives as a ctrl+wheel with small deltas.
      const intensity = event.ctrlKey ? 0.012 : 0.003;
      zoomBy(Math.exp(-delta * intensity));
    },
    [zoomBy],
  );

  // Bound to the live canvas element, not a ref read once: the canvas unmounts
  // while no agents match and comes back as a new element.
  useEffect(() => onWheel(canvas, handleWheel), [canvas, handleWheel]);

  const canvasPan = useMemo(
    () =>
      PanResponder.create({
        // Only motion past the drag threshold pans; taps reach the Pressable.
        onMoveShouldSetPanResponderCapture: (_event, gesture) => isDrag(gesture.dx, gesture.dy),
        onMoveShouldSetPanResponder: (_event, gesture) => isDrag(gesture.dx, gesture.dy),
        onPanResponderGrant: () => {
          panStart.current = panRef.current;
          canvasGuard.markDragged();
        },
        onPanResponderMove: (_event, gesture) => {
          setPan({ x: panStart.current.x + gesture.dx, y: panStart.current.y + gesture.dy });
        },
      }),
    [canvasGuard],
  );

  const activeFilterCount =
    (hostFilter ? 1 : 0) +
    (projectFilter ? 1 : 0) +
    (workspaceFilter ? 1 : 0) +
    (providerFilter ? 1 : 0) +
    (showSubagents ? 0 : 1) +
    (connectedOnly ? 1 : 0);

  const touchTarget = compact
    ? ({
        minWidth: CONTROL_MIN_COMPACT,
        minHeight: CONTROL_MIN_COMPACT,
        alignItems: "center",
        justifyContent: "center",
      } as const)
    : null;

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
          borderBottomColor: theme.colors.border,
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
            accessibilityState={{ expanded: filtersOpen }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              minHeight: compact ? CONTROL_MIN_COMPACT : 26,
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
          <Chip
            label="Fit"
            active={false}
            toggle={false}
            compact={compact}
            theme={theme}
            onPress={fit}
          />
          <ZoomButton label="−" compact={compact} theme={theme} onPress={() => zoomBy(1 / 1.2)} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, minWidth: 34 }}>
            {Math.round(scale * 100)}%
          </Text>
          <ZoomButton label="+" compact={compact} theme={theme} onPress={() => zoomBy(1.2)} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset graph view"
            onPress={resetView}
            style={{ paddingHorizontal: 6, paddingVertical: 4, ...touchTarget }}
          >
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
                  compact={compact}
                  onPress={() => setHostFilter(null)}
                />
                {hostChoices.map((host) => (
                  <Chip
                    key={host.serverId}
                    label={host.label}
                    color={hostColor(host)}
                    active={hostFilter === host.serverId}
                    theme={theme}
                    compact={compact}
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
                compact={compact}
                onPress={() => setProjectFilter(null)}
              />
              {projects.map((project) => (
                <Chip
                  key={project}
                  label={project}
                  color={PALETTE[colorIndex(projectKeys.get(project) ?? project)]}
                  active={projectFilter === project}
                  theme={theme}
                  compact={compact}
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
                compact={compact}
                onPress={() => setWorkspaceFilter(null)}
              />
              {workspaces.map((workspace) => (
                <Chip
                  key={workspace}
                  label={workspace}
                  active={workspaceFilter === workspace}
                  theme={theme}
                  compact={compact}
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
                compact={compact}
                onPress={() => setProviderFilter(null)}
              />
              {providers.map((provider) => (
                <Chip
                  key={provider}
                  label={provider}
                  active={providerFilter === provider}
                  theme={theme}
                  compact={compact}
                  onPress={() => setProviderFilter(providerFilter === provider ? null : provider)}
                />
              ))}
              <Chip
                label={`Subagents ${subagentCount}`}
                active={showSubagents}
                theme={theme}
                compact={compact}
                onPress={() => setShowSubagents((value) => !value)}
              />
              <Chip
                label="Connected only"
                active={connectedOnly}
                theme={theme}
                compact={compact}
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
        ref={setCanvas}
      >
        <View
          style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}
          {...canvasPan.panHandlers}
        >
          {/* A tap on empty canvas clears the focus; a drag pans instead. */}
          <Pressable
            accessible={false}
            focusable={false}
            onPressIn={canvasGuard.reset}
            onPress={() => {
              if (canvasGuard.consume()) clearSelection();
            }}
            style={{ flex: 1 }}
          />
        </View>
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
                    color: theme.colors.foregroundMuted,
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
                  : theme.colors.foregroundMuted;
            const hitHeight = Math.max(compact ? 24 / scale : 12, thickness);
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
                hitSlop={compact ? 14 : 0}
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
                  borderColor: edgeSelected ? theme.colors.accent : theme.colors.border,
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
            return (
              <GraphNodeView
                key={node.id}
                node={node}
                host={hostChoices.length > 1 ? node.host : null}
                position={position}
                scale={scale}
                dimmed={dimmed}
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
              borderColor: theme.colors.border,
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
                style={{ padding: 4, ...touchTarget }}
              >
                <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
              </Pressable>
            </View>
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {selected.host ? `${selected.host.label} · ` : ""}
              {selected.repo}
            </Text>
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
                  ...(compact
                    ? { minHeight: CONTROL_MIN_COMPACT, justifyContent: "center" }
                    : null),
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
              borderColor: theme.colors.accent,
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
                style={{ padding: 4, ...touchTarget }}
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
  toggle = true,
  color,
  compact,
  theme,
  onPress,
}: {
  label: string;
  active: boolean;
  /** False for one-shot actions, which have no selected state to announce. */
  toggle?: boolean;
  color?: string;
  compact: boolean;
  theme: PluginSurfaceProps["theme"];
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={toggle ? { selected: active } : undefined}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        maxWidth: 190,
        minHeight: compact ? CONTROL_MIN_COMPACT : 26,
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
  compact,
  theme,
  onPress,
}: {
  label: string;
  compact: boolean;
  theme: PluginSurfaceProps["theme"];
  onPress: () => void;
}) {
  const size = compact ? CONTROL_MIN_COMPACT : 24;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label === "+" ? "Zoom in" : "Zoom out"}
      onPress={onPress}
      style={{
        width: size,
        height: size,
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
  host,
  position,
  scale,
  dimmed,
  selected,
  theme,
  onSelect,
  onMove,
}: {
  node: GraphNode;
  /** Shown as a pill when the graph spans more than one host. */
  host: HostScope | null;
  position: { x: number; y: number };
  scale: number;
  dimmed: boolean;
  selected: boolean;
  theme: PluginSurfaceProps["theme"];
  onSelect: (id: string) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
}) {
  const start = useRef({ x: 0, y: 0 });
  const positionRef = useRef(position);
  const scaleRef = useRef(scale);
  const guard = useMemo(createPressGuard, []);
  positionRef.current = position;
  scaleRef.current = scale;

  // The responder only claims motion past the drag threshold (stealing it from
  // the Pressable), so taps, Enter, Space and screen-reader activation stay
  // native presses. dx/dy are measured from the grant, which is also when the
  // card's origin is captured.
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) => isDrag(gesture.dx, gesture.dy),
        onMoveShouldSetPanResponder: (_event, gesture) => isDrag(gesture.dx, gesture.dy),
        onPanResponderGrant: () => {
          start.current = positionRef.current;
          guard.markDragged();
        },
        onPanResponderMove: (_event, gesture) => {
          onMove(node.id, {
            x: start.current.x + gesture.dx / scaleRef.current,
            y: start.current.y + gesture.dy / scaleRef.current,
          });
        },
      }),
    [guard, node.id, onMove],
  );

  const border = selected
    ? theme.colors.accent
    : node.kind === "subagent"
      ? theme.colors.statusWarning
      : PALETTE[colorIndex(node.colorKey)] + "88";

  return (
    <View
      {...responder.panHandlers}
      style={{ position: "absolute", left: position.x, top: position.y, width: NODE_WIDTH }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Select ${node.title}`}
        accessibilityState={{ selected }}
        onPressIn={guard.reset}
        onPress={() => {
          if (guard.consume()) onSelect(node.id);
        }}
        style={{
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
          {host ? (
            <View
              accessibilityLabel={`Host ${host.label}`}
              style={{
                paddingHorizontal: 6,
                paddingVertical: 1,
                borderRadius: 7,
                borderWidth: 1,
                borderColor: `${hostColor(host)}66`,
                backgroundColor: `${hostColor(host)}26`,
              }}
            >
              <Text style={{ color: hostColor(host), fontSize: 9, fontWeight: "700" }}>
                {host.label}
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
      </Pressable>
    </View>
  );
}
