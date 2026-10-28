import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { requestAgentOpen, setCycleList } from "./focus-request";
import { age, attentionCount, attentionItems, hostColor } from "./monitor";
import { useAllHostsMonitor } from "./monitor-data";
import { digitIndex, moveSelection, type OverviewItem, overviewItems } from "./overview";
import { useKeyDown, type WebKeyEvent } from "./web-keys";

export const MONITOR_SCREEN_ID = "monitor";
const OVERVIEW_LIMIT = 12;

/**
 * Attention state across every online host, sharing the screen's merged query
 * so the badge never misses an agent on another host. A host that fails to
 * load makes the count a lower bound instead of hiding it.
 */
function useAttention() {
  const monitor = useAllHostsMonitor();
  const items = useMemo(() => attentionItems(monitor.entries), [monitor.entries]);
  useEffect(() => {
    setCycleList(
      overviewItems(monitor.entries).map((item) => ({
        agentId: item.id,
        serverId: item.host?.serverId,
      })),
    );
  }, [monitor.entries]);
  return {
    items,
    summary: attentionCount({
      items,
      truncated: monitor.truncated,
      failed: monitor.failedHosts.length > 0,
      loading: monitor.isPending,
    }),
  };
}

export function MonitorSidebarItem({
  theme,
  currentScreen,
  openScreen,
  openPopover,
}: PluginSidebarItemProps) {
  const { summary } = useAttention();
  const label =
    summary && summary.count > 0 ? `${summary.count}${summary.lowerBound ? "+" : ""}` : null;
  const styles = useMemo(
    () => ({
      badge: {
        minWidth: 20,
        height: 20,
        paddingHorizontal: 6,
        borderRadius: 10,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.accent,
      },
      badgeText: { color: theme.colors.accentForeground, fontSize: 11, fontWeight: "600" as const },
    }),
    [theme],
  );
  return (
    <SidebarRow
      icon="Radar"
      label="Agent monitor"
      active={currentScreen?.screenId === MONITOR_SCREEN_ID}
      onPress={() => openScreen({ screenId: MONITOR_SCREEN_ID })}
      trailing={
        label ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label} agents need attention`}
            onPress={() => openPopover(AttentionPopover)}
            style={styles.badge}
          >
            <Text style={styles.badgeText}>{label}</Text>
          </Pressable>
        ) : null
      }
    />
  );
}

function openOverlayItem(openScreen: PluginPopoverProps["openScreen"], item: OverviewItem): void {
  const token = String(Date.now());
  requestAgentOpen({ agentId: item.id, serverId: item.host?.serverId, token });
  openScreen({
    screenId: MONITOR_SCREEN_ID,
    params: { openAgent: token },
  });
}

function AttentionPopover({ theme, layout, openScreen }: PluginPopoverProps) {
  const { items, summary } = useAttention();
  const monitor = useAllHostsMonitor();
  const overview = useMemo(() => overviewItems(monitor.entries), [monitor.entries]);
  const [selected, setSelected] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(clock);
  }, []);
  useEffect(() => {
    if (selected >= overview.length) setSelected(overview.length > 0 ? 0 : -1);
  }, [overview.length, selected]);
  useKeyDown(
    useCallback(
      (event: WebKeyEvent) => {
        // The app dismisses the popover on Escape; never fight it here.
        if (event.key === "Escape") return;
        if (event.key === "Enter") {
          const item = overview[selected];
          if (item) openOverlayItem(openScreen, item);
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          setSelected((index) => moveSelection(index, overview.length, event.shiftKey ? -1 : 1));
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          event.preventDefault();
          setSelected((index) => moveSelection(index, overview.length, 1));
          return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          event.preventDefault();
          setSelected((index) => moveSelection(index, overview.length, -1));
          return;
        }
        const jump = digitIndex(event.key);
        if (jump !== null && jump < overview.length) {
          const item = overview[jump];
          setSelected(jump);
          if (item) openOverlayItem(openScreen, item);
        }
      },
      [overview, selected, openScreen],
    ),
  );
  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 10 : 6, minWidth: 300 },
      heading: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      sectionHead: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        marginTop: 6,
      },
      rowPress: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 4,
        paddingHorizontal: 6,
        borderRadius: 8,
      },
      rowSelected: {
        backgroundColor: theme.colors.surface2,
      },
      badge: {
        minWidth: 20,
        alignItems: "center" as const,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        paddingHorizontal: 5,
        paddingVertical: 1,
      },
      badgeText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      rowBody: { flex: 1, gap: 1 },
      rowTitleLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      rowTitle: { flex: 1, color: theme.colors.foreground, fontSize: 13 },
      rowState: { color: theme.colors.foregroundMuted, fontSize: 12 },
      action: {
        minHeight: 36,
        justifyContent: "center" as const,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      actionText: { color: theme.colors.foreground, fontSize: 13 },
    }),
    [theme, layout.compact],
  );
  const shown = overview.slice(0, OVERVIEW_LIMIT);
  const hidden = overview.length - shown.length;
  const runningCount = overview.filter((item) => !item.needsAttention).length;
  let heading = "Checking agents…";
  if (summary) {
    const attention =
      summary.count === 0
        ? summary.lowerBound
          ? "None of the newest agents need attention; older ones were not checked"
          : "No agents need attention"
        : `${summary.count}${summary.lowerBound ? "+" : ""} need attention`;
    heading =
      runningCount > 0 && summary.count > 0 ? `${attention} · ${runningCount} running` : attention;
  } else if (items) {
    heading = "Attention list may be out of date";
  }
  return (
    <View style={styles.root}>
      <Text style={styles.heading}>{heading}</Text>
      {shown.map((item, index) => {
        const color = item.host ? hostColor(item.host) : theme.colors.foregroundMuted;
        const isSelected = index === selected;
        const startsAttention = index === 0 && item.needsAttention;
        const startsRunning = index > 0 && !item.needsAttention && shown[index - 1]?.needsAttention;
        return (
          <Fragment key={item.id}>
            {startsAttention ? <Text style={styles.sectionHead}>Needs attention</Text> : null}
            {startsRunning ? <Text style={styles.sectionHead}>Running</Text> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.title}`}
              onPress={() => {
                setSelected(index);
                openOverlayItem(openScreen, item);
              }}
              style={[styles.rowPress, isSelected ? styles.rowSelected : null]}
            >
              {index < 9 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{index + 1}</Text>
                </View>
              ) : (
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: item.needsAttention
                      ? theme.colors.statusWarning
                      : theme.colors.foregroundMuted,
                  }}
                />
              )}
              <View style={styles.rowBody}>
                <View style={styles.rowTitleLine}>
                  <Text style={styles.rowTitle} numberOfLines={1} ellipsizeMode="tail">
                    {item.title}
                  </Text>
                  {item.host ? (
                    <View
                      accessibilityLabel={`Host ${item.host.label}`}
                      style={{
                        paddingHorizontal: 6,
                        paddingVertical: 1,
                        borderRadius: 7,
                        borderWidth: 1,
                        borderColor: `${color}66`,
                        backgroundColor: `${color}26`,
                      }}
                    >
                      <Text style={{ color, fontSize: 9, fontWeight: "700" }}>
                        {item.host.label}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.rowState} numberOfLines={1} ellipsizeMode="tail">
                  {item.state} · {age(item.since, now)} · {item.detail}
                </Text>
              </View>
            </Pressable>
          </Fragment>
        );
      })}
      {hidden > 0 ? <Text style={styles.detail}>and {hidden} more</Text> : null}
      {shown.length === 0 && summary ? (
        <Text style={styles.detail}>No running agents right now.</Text>
      ) : null}
      <Text style={styles.detail}>1-9 jump straight in · Tab moves · Enter opens · Esc closes</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open monitor"
        onPress={() => openScreen({ screenId: MONITOR_SCREEN_ID, params: { bucket: "attention" } })}
        style={styles.action}
      >
        <Text style={styles.actionText}>Open monitor</Text>
      </Pressable>
    </View>
  );
}
