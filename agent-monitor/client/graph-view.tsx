import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, ScrollView, Text, View } from "react-native";
import {
  buildGraph,
  edgeLabel,
  edgeThickness,
  type GraphNode,
  type InteractionData,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "./graph";
import { type AgentEntry, bucketOf, placement } from "./monitor";

type GraphViewProps = {
  entries: AgentEntry[];
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

const projectNameOf = (node: GraphNode): string => node.colorKey.split(" · ")[0] || "Project";

export function AgentGraph({ entries, interactions, loading, theme, navigation }: GraphViewProps) {
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [showSubagents, setShowSubagents] = useState(true);
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manual, setManual] = useState<Record<string, { x: number; y: number }>>({});
  const [scale, setScale] = useState(1);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  const projectKeys = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entries) {
      const name = entry.project.projectName;
      if (name && !map.has(name)) map.set(name, placement(entry));
    }
    return map;
  }, [entries]);
  const projects = useMemo(() => [...projectKeys.keys()].sort(), [projectKeys]);
  const providers = useMemo(
    () => [...new Set(entries.map((entry) => entry.agent.provider))].sort(),
    [entries],
  );
  const filteredEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (!projectFilter || entry.project.projectName === projectFilter) &&
          (!providerFilter || entry.agent.provider === providerFilter),
      ),
    [entries, projectFilter, providerFilter],
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
    () => (connectedOnly ? layout.nodes.filter((node) => (degree.get(node.id) ?? 0) > 0) : layout.nodes),
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
  const visibleClusters = useMemo(
    () =>
      layout.clusters
        .map((cluster) => ({
          ...cluster,
          count: visibleNodes.filter((node) => node.colorKey === cluster.key).length,
        }))
        .filter((cluster) => cluster.count > 0),
    [layout.clusters, visibleNodes],
  );

  const positionOf = useCallback(
    (node: GraphNode) => manual[node.id] ?? { x: node.x, y: node.y },
    [manual],
  );

  const neighborIds = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const ids = new Set<string>([selectedId]);
    for (const edge of visibleEdges) {
      if (edge.from === selectedId) ids.add(edge.to);
      if (edge.to === selectedId) ids.add(edge.from);
    }
    return ids;
  }, [selectedId, visibleEdges]);

  const selected = selectedId ? visibleById.get(selectedId) ?? null : null;

  const moveNode = useCallback((id: string, position: { x: number; y: number }) => {
    setManual((current) => ({ ...current, [id]: position }));
  }, []);

  const resetView = useCallback(() => {
    setSelectedId(null);
    setManual({});
    setScale(1);
    setProjectFilter(null);
    setProviderFilter(null);
    setShowSubagents(true);
    setConnectedOnly(false);
  }, []);

  const fit = useCallback(() => {
    if (!viewport.width || !viewport.height || !layout.width || !layout.height) return;
    const next = Math.min(
      (viewport.width - 40) / layout.width,
      (viewport.height - 40) / layout.height,
      1.4,
    );
    setScale(Math.max(0.35, next));
    setManual({});
  }, [viewport.height, viewport.width, layout.height, layout.width]);

  if (entries.length === 0) {
    return (
      <View style={{ padding: 20 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          No agents match this filter.
        </Text>
      </View>
    );
  }

  const scaledWidth = layout.width * scale;
  const scaledHeight = layout.height * scale;

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
          <Chip label="Fit" active={false} theme={theme} onPress={fit} />
          <ZoomButton label="−" theme={theme} onPress={() => setScale((value) => Math.max(0.35, value - 0.15))} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, minWidth: 34 }}>
            {Math.round(scale * 100)}%
          </Text>
          <ZoomButton label="+" theme={theme} onPress={() => setScale((value) => Math.min(2.5, value + 0.15))} />
          <Pressable onPress={resetView} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Reset</Text>
          </Pressable>
          {loading ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>reading timelines…</Text>
          ) : null}
        </View>
      </View>

      <View
        style={{ flex: 1 }}
        onLayout={(event) =>
          setViewport({
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height,
          })
        }
      >
        <ScrollView horizontal contentContainerStyle={{ width: scaledWidth }}>
          <ScrollView
            nestedScrollEnabled
            contentContainerStyle={{ width: scaledWidth, height: scaledHeight }}
          >
            <View
              style={{
                width: layout.width,
                height: layout.height,
                transform: [{ scale }],
                transformOrigin: "left top",
              }}
            >
              {visibleClusters.map((cluster) => {
                const color = PALETTE[colorIndex(cluster.key)];
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
                const x1 = a.x + NODE_WIDTH;
                const y1 = a.y + NODE_HEIGHT / 2;
                const x2 = b.x;
                const y2 = b.y + NODE_HEIGHT / 2;
                const dx = x2 - x1;
                const dy = y2 - y1;
                const length = Math.hypot(dx, dy);
                const angle = Math.atan2(dy, dx);
                const thickness = edgeThickness(edge.count);
                const active = !selectedId || edge.from === selectedId || edge.to === selectedId;
                const color =
                  edge.kind === "message"
                    ? theme.colors.accent
                    : edge.kind === "subagent"
                      ? theme.colors.statusWarning
                      : theme.colors.border;
                return (
                  <View
                    key={`${edge.from}>${edge.to}`}
                    style={{
                      position: "absolute",
                      left: x1,
                      top: y1 - thickness / 2,
                      width: length,
                      height: thickness,
                      borderRadius: thickness / 2,
                      backgroundColor: color,
                      opacity: active ? (edge.kind === "tree" ? 0.7 : 0.85) : 0.1,
                      transform: [{ rotate: `${angle}rad` }],
                      transformOrigin: "left center",
                    }}
                  />
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
                const x = (a.x + NODE_WIDTH + b.x) / 2;
                const y = (a.y + b.y) / 2 + NODE_HEIGHT / 2;
                return (
                  <View
                    key={`label-${edge.from}>${edge.to}`}
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
                      borderColor: theme.colors.border + "66",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>{label}</Text>
                  </View>
                );
              })}

              {visibleNodes.map((node) => {
                const position = positionOf(node);
                const dimmed = selectedId !== null && !neighborIds.has(node.id);
                return (
                  <GraphNodeView
                    key={node.id}
                    node={node}
                    position={position}
                    scale={scale}
                    dimmed={dimmed}
                    selected={selectedId === node.id}
                    theme={theme}
                    onSelect={setSelectedId}
                    onMove={moveNode}
                  />
                );
              })}
            </View>
          </ScrollView>
        </ScrollView>

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
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {selected.meta} · {selected.messageCount} messages
              {selected.childCount > 0 ? ` · ${selected.childCount} children` : ""}
            </Text>
            {selected.agentId ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open agent ${selected.title}`}
                onPress={() => navigation?.openAgent({ agentId: selected.agentId ?? "" })}
                style={{
                  alignSelf: "flex-start",
                  marginTop: 4,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  borderRadius: 6,
                  backgroundColor: theme.colors.accent,
                }}
              >
                <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "600" }}>
                  Open agent
                </Text>
              </Pressable>
            ) : null}
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
  selected,
  theme,
  onSelect,
  onMove,
}: {
  node: GraphNode;
  position: { x: number; y: number };
  scale: number;
  dimmed: boolean;
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
          onMove(node.id, {
            x: start.current.x + gesture.dx / scaleRef.current,
            y: start.current.y + gesture.dy / scaleRef.current,
          });
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
        minHeight: NODE_HEIGHT,
        padding: 9,
        borderRadius: 10,
        borderWidth: selected ? 2 : 1,
        borderStyle: node.kind === "subagent" ? "dashed" : "solid",
        borderColor: border,
        backgroundColor: theme.colors.surface1,
        opacity: dimmed ? 0.2 : 1,
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
