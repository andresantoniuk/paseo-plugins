import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  buildGraph,
  edgeLabel,
  edgeThickness,
  NODE_HEIGHT,
  NODE_WIDTH,
  repoLabel,
  type InteractionData,
} from "./graph";
import { type AgentEntry, bucketOf, childCounts, stateLabel, title } from "./monitor";

type GraphViewProps = {
  entries: AgentEntry[];
  interactions: InteractionData | undefined;
  loading: boolean;
  theme: PluginSurfaceProps["theme"];
  navigation: PluginSurfaceProps["navigation"];
  compact: boolean;
};

export function AgentGraph({ entries, interactions, loading, theme, navigation }: GraphViewProps) {
  const layout = useMemo(() => buildGraph(entries, interactions), [entries, interactions]);
  const childCountByParent = useMemo(() => childCounts(entries), [entries]);

  const statusColor = (entry: AgentEntry): string => {
    const bucket = bucketOf(entry.agent);
    if (entry.agent.status === "error") return theme.colors.statusDanger;
    if (bucket === "attention") return theme.colors.statusWarning;
    if (bucket === "running") return theme.colors.statusSuccess;
    return theme.colors.foregroundMuted;
  };

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
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 16,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border + "66",
        }}
      >
        <Legend color={theme.colors.statusSuccess} label="running" theme={theme} />
        <Legend color={theme.colors.statusWarning} label="attention" theme={theme} />
        <Legend color={theme.colors.statusDanger} label="error" theme={theme} />
        <Legend color={theme.colors.foregroundMuted} label="idle / closed" theme={theme} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
          edge thickness = messages
        </Text>
        {loading ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>reading timelines…</Text>
        ) : null}
      </View>

      <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ minWidth: layout.width }}>
        <ScrollView
          nestedScrollEnabled
          contentContainerStyle={{ width: layout.width, height: layout.height }}
        >
          <View style={{ width: layout.width, height: layout.height }}>
            {layout.edges.map((edge) => {
              const from = layout.byId.get(edge.from);
              const to = layout.byId.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + NODE_WIDTH;
              const y1 = from.y + NODE_HEIGHT / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_HEIGHT / 2;
              const dx = x2 - x1;
              const dy = y2 - y1;
              const length = Math.hypot(dx, dy);
              const angle = Math.atan2(dy, dx);
              const thickness = edgeThickness(edge.count);
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
                    backgroundColor:
                      edge.kind === "tree" ? theme.colors.border : theme.colors.accent,
                    opacity: edge.kind === "tree" ? 0.65 : 0.5,
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
              const x = (from.x + NODE_WIDTH + to.x) / 2;
              const y = (from.y + to.y) / 2 + NODE_HEIGHT / 2;
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

            {layout.nodes.map(({ entry, x, y }) => {
              const color = statusColor(entry);
              const children = childCountByParent.get(entry.agent.id) ?? 0;
              const messages = interactions?.messagesByAgent.get(entry.agent.id) ?? 0;
              return (
                <Pressable
                  key={entry.agent.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Open agent ${title(entry)}`}
                  onPress={() => navigation?.openAgent({ agentId: entry.agent.id })}
                  style={({ pressed }) => ({
                    position: "absolute",
                    left: x,
                    top: y,
                    width: NODE_WIDTH,
                    minHeight: NODE_HEIGHT,
                    padding: 9,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: color + "88",
                    backgroundColor: theme.colors.surface1,
                    opacity: pressed ? 0.7 : 1,
                    gap: 2,
                  })}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="tail"
                      style={{
                        flex: 1,
                        color: theme.colors.foreground,
                        fontSize: 13,
                        fontWeight: "600",
                      }}
                    >
                      {title(entry)}
                    </Text>
                    {bucketOf(entry.agent) === "attention" ? (
                      <Text
                        style={{
                          color: theme.colors.statusWarning,
                          fontSize: 9,
                          fontWeight: "700",
                        }}
                      >
                        ATTENTION
                      </Text>
                    ) : null}
                  </View>
                  <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}
                  >
                    {repoLabel(entry)}
                  </Text>
                  <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}
                  >
                    {entry.agent.provider}
                    {entry.agent.model ? ` · ${entry.agent.model}` : ""} · {stateLabel(entry.agent)}
                    {messages > 0 ? ` · ${messages} msgs` : ""}
                  </Text>
                  {children > 0 ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>
                      {children} {children === 1 ? "subagent" : "subagents"}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function Legend({
  color,
  label,
  theme,
}: {
  color: string;
  label: string;
  theme: PluginSurfaceProps["theme"];
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{label}</Text>
    </View>
  );
}
