import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { requestAgentFocus } from "./focus-request";
import { type AttentionItem, age, attentionItems, hostColor } from "./monitor";
import { useAllHostsMonitor } from "./monitor-data";

export const MONITOR_SCREEN_ID = "monitor";
const POPOVER_LIMIT = 8;

/**
 * Attention state across every online host, sharing the screen's merged query
 * so the badge never misses an agent on another host. A host that fails to
 * load makes the count a lower bound instead of hiding it.
 */
function useAttention() {
  const monitor = useAllHostsMonitor();
  const items = useMemo(() => attentionItems(monitor.entries), [monitor.entries]);
  const failed = monitor.failedHosts.length > 0;
  const loading = monitor.isPending && items.length === 0;
  return {
    items,
    summary:
      loading || (failed && items.length === 0)
        ? null
        : { count: items.length, lowerBound: monitor.truncated || failed },
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

function AttentionPopover({ theme, layout, openScreen }: PluginPopoverProps) {
  const { items, summary } = useAttention();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(clock);
  }, []);
  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 10 : 6 },
      heading: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      rowPress: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 4,
      },
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
  const shown: readonly AttentionItem[] = items?.slice(0, POPOVER_LIMIT) ?? [];
  const hidden = (items?.length ?? 0) - shown.length;
  let heading = "Checking agents…";
  if (summary) {
    heading =
      summary.count === 0
        ? summary.lowerBound
          ? "None of the newest agents need attention; older ones were not checked"
          : "No agents need attention"
        : `${summary.count}${summary.lowerBound ? "+" : ""} need attention`;
  } else if (items) {
    heading = "Attention list may be out of date";
  }
  return (
    <View style={styles.root}>
      <Text style={styles.heading}>{heading}</Text>
      {shown.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.title} in the monitor`}
          onPress={() => {
            requestAgentFocus(item.id);
            openScreen({
              screenId: MONITOR_SCREEN_ID,
              params: { bucket: "attention", agent: item.id },
            });
          }}
          style={styles.rowPress}
        >
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: theme.colors.statusWarning,
            }}
          />
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
                    borderColor: `${hostColor(item.host)}66`,
                    backgroundColor: `${hostColor(item.host)}26`,
                  }}
                >
                  <Text style={{ color: hostColor(item.host), fontSize: 9, fontWeight: "700" }}>
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
      ))}
      {hidden > 0 ? <Text style={styles.detail}>and {hidden} more</Text> : null}
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
