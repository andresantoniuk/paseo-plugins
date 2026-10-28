import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { age, hostColor } from "./monitor";
import { useAllHostsMonitor } from "./monitor-data";
import { digitIndex, moveSelection, type OverviewItem, overviewItems } from "./overview";
import { useKeyDown, type WebKeyEvent } from "./web-keys";

function openItem(navigation: PluginScreenProps["navigation"], item: OverviewItem): void {
  if (!navigation) return;
  try {
    navigation.openAgent({ agentId: item.id, serverId: item.host?.serverId });
  } catch {
    // The agent may be gone by the time the key lands; staying put is fine.
  }
}

export function AgentOverview(props: {
  theme: PluginScreenProps["theme"];
  layout: PluginScreenProps["layout"];
  navigation: PluginScreenProps["navigation"];
  onExit?: () => void;
}) {
  const monitor = useAllHostsMonitor();
  const items = useMemo(() => overviewItems(monitor.entries), [monitor.entries]);
  const [selected, setSelected] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    if (selected >= items.length) setSelected(items.length > 0 ? 0 : -1);
  }, [items.length, selected]);

  const onKeyDown = useCallback(
    (event: WebKeyEvent) => {
      if (event.key === "Escape") {
        if (props.onExit) props.onExit();
        else setSelected(-1);
        return;
      }
      if (event.key === "Enter") {
        const item = items[selected];
        if (item) openItem(props.navigation, item);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        setSelected((index) => moveSelection(index, items.length, event.shiftKey ? -1 : 1));
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        setSelected((index) => moveSelection(index, items.length, 1));
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        setSelected((index) => moveSelection(index, items.length, -1));
        return;
      }
      const jump = digitIndex(event.key);
      if (jump !== null && jump < items.length) {
        const item = items[jump];
        setSelected(jump);
        if (item) openItem(props.navigation, item);
      }
    },
    [items, selected, props.navigation, props.onExit],
  );
  useKeyDown(onKeyDown);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: props.layout.compact ? 16 : 24,
        backgroundColor: props.theme.colors.surface0,
      },
      heading: { color: props.theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      sub: { color: props.theme.colors.foregroundMuted, fontSize: 12, marginTop: 4 },
      grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 12, marginTop: 16 },
      card: {
        minWidth: 220,
        maxWidth: 320,
        flexGrow: 1,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: props.theme.colors.border,
        backgroundColor: props.theme.colors.surface1,
        padding: 12,
      },
      cardSelected: { borderColor: props.theme.colors.accent, borderWidth: 2, padding: 11 },
      cardAttention: { borderColor: props.theme.colors.statusWarning },
      topRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      badge: {
        minWidth: 20,
        alignItems: "center" as const,
        borderRadius: 6,
        backgroundColor: props.theme.colors.surface2,
        paddingHorizontal: 5,
        paddingVertical: 1,
      },
      badgeText: { color: props.theme.colors.foregroundMuted, fontSize: 11 },
      pill: {
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        marginLeft: "auto" as const,
      },
      pillText: { fontSize: 11, fontWeight: "600" as const },
      titleText: {
        color: props.theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
        marginTop: 8,
      },
      detailText: { color: props.theme.colors.foregroundMuted, fontSize: 12, marginTop: 4 },
      hint: { color: props.theme.colors.foregroundMuted, fontSize: 12, marginTop: 16 },
      empty: { color: props.theme.colors.foregroundMuted, fontSize: 13, marginTop: 16 },
    }),
    [props.layout.compact, props.theme],
  );

  const attention = items.filter((item) => item.needsAttention).length;
  return (
    <View style={styles.screen}>
      <Text style={styles.heading}>Agents</Text>
      <Text style={styles.sub}>
        {monitor.isPending ? "Loading…" : `${items.length} active · ${attention} need attention`}
      </Text>
      {items.length === 0 && !monitor.isPending ? (
        <Text style={styles.empty}>No running agents right now.</Text>
      ) : null}
      <View style={styles.grid}>
        {items.map((item, index) => {
          const color = item.host ? hostColor(item.host) : props.theme.colors.foregroundMuted;
          const isSelected = index === selected;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.title}`}
              onPress={() => {
                setSelected(index);
                openItem(props.navigation, item);
              }}
              style={[
                styles.card,
                item.needsAttention ? styles.cardAttention : null,
                isSelected ? styles.cardSelected : null,
              ]}
            >
              <View style={styles.topRow}>
                {index < 9 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{index + 1}</Text>
                  </View>
                ) : null}
                <Text style={styles.detailText} numberOfLines={1}>
                  {item.state}
                  {item.needsAttention ? ` · ${age(item.since, now)}` : ""}
                </Text>
                {item.host ? (
                  <View style={[styles.pill, { backgroundColor: `${color}22` }]}>
                    <Text style={[styles.pillText, { color }]}>{item.host.label}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.titleText} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={styles.detailText} numberOfLines={1}>
                {item.detail}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.hint}>
        1-9 jump straight in · Tab moves · Enter opens · Esc backs out
      </Text>
    </View>
  );
}
