import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  buildGraph,
  edgeLabel,
  edgeThickness,
  GRAPH_PADDING,
  type GraphEdge,
  type GraphNode,
  type InteractionData,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "./graph";
import { type AgentEntry, bucketOf } from "./monitor";

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

function projectName(node: GraphNode): string {
  return node.colorKey.split(" · ")[0] || "Project";
}

export function AgentGraph({ entries, interactions, loading, theme, navigation }: GraphViewProps) {
  const layout = useMemo(() => buildGraph(entries, interactions), [entries, interactions]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manual, setManual] = useState<Record<string, { x: number; y: number }>>({});
  const [scale, setScale] = useState(1);

  const positionOf = useCallback(
    (node: GraphNode) => manual[node.id] ?? { x: node.x, y: node.y },
    [manual],
  );

  const neighborIds = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const ids = new Set<string>([selectedId]);
    for (const edge of layout.edges) {
      if (edge.from === selectedId) ids.add(edge.to);
      if (edge.to === selectedId) ids.add(edge.from);
    }
    return ids;
  }, [layout.edges, selectedId]);

  const selected = selectedId ? layout.byId.get(selectedId) ?? null : null;

  const moveNode = useCallback((id: string, position: { x: number; y: number }) => {
    setManual((current) => ({ ...current, [id]: position }));
  }, []);

  const resetView = useCallback(() => {
    setSelectedId(null);
    setManual({});
    setScale(1);
  }, []);

  const legend = useMemo(() => {
    const seen = new Map<string, string>();
    for (const node of layout.nodes) {
      const key = projectName(node);
      if (!seen.has(key)) seen.set(key, node.colorKey);
    }
    return [...seen.entries()].slice(0, 6).map(([name, key]) => ({ name, color: PALETTE[colorIndex(key)] }));
  }, [layout.nodes]);

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
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border + "66",
        }}
      >
        <ZoomButton label="−" theme={theme} onPress={() => setScale((value) => Math.max(0.5, value - 0.15))} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, minWidth: 36 }}>
          {Math.round(scale * 100)}%
        </Text>
        <ZoomButton label="+" theme={theme} onPress={() => setScale((value) => Math.min(2, value + 0.15))} />
        <Pressable onPress={resetView} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Reset</Text>
        </Pressable>
        {legend.map((entry) => (
          <View key={entry.name} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: entry.color }} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{entry.name}</Text>
          </View>
        ))}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View
            style={{
              width: 14,
              height: 1,
              backgroundColor: theme.colors.statusWarning,
            }}
          />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>subagent</Text>
        </View>
        {loading ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>reading timelines…</Text>
        ) : null}
      </View>

      <View style={{ flex: 1 }}>
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
              {layout.edges.map((edge) => {
                const from = layout.byId.get(edge.from);
                const to = layout.byId.get(edge.to);
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
                const active =
                  !selectedId || edge.from === selectedId || edge.to === selectedId;
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
                      opacity: active ? (edge.kind === "tree" ? 0.7 : 0.85) : 0.12,
                      transform: [{ rotate: `${angle}rad` }],
                      transformOrigin: "left center",
                    }}
                  />
                );
              })}

              {layout.edges.map((edge) => {
                const label = edgeLabel(edge.count);
                if (!label) return null;
                const from = layout.byId.get(edge.from);
                const to = layout.byId.get(edge.to);
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

              {layout.nodes.map((node) => {
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
                    navigation={navigation}
                    onSelect={setSelectedId}
                    onMove={moveNode}
                    onOpen={(agentId) => navigation?.openAgent({ agentId })}
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
  onOpen,
}: {
  node: GraphNode;
  position: { x: number; y: number };
  scale: number;
  dimmed: boolean;
  selected: boolean;
  theme: PluginSurfaceProps["theme"];
  navigation: PluginSurfaceProps["navigation"];
  onSelect: (id: string) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
  onOpen: (agentId: string) => void;
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
          style={{
            flex: 1,
            color: theme.colors.foreground,
            fontSize: 12,
            fontWeight: "700",
          }}
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
