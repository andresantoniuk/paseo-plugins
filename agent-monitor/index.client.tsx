import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { AgentMonitor } from "./client/agent-monitor";
import { requestAgentOpen, stepCycle } from "./client/focus-request";
import { MonitorSettingsScreen } from "./client/settings-screen";
import { MONITOR_SCREEN_ID, MonitorSidebarItem } from "./client/sidebar";

export const OVERVIEW_VIEW_PARAM = "overview";

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "monitor",
    title: "Monitor settings",
    icon: "Settings",
    Component: MonitorSettingsScreen,
  });

  // Registered under the retired sidebar item's id so saved links keep working.
  const removeScreen = client.addScreen({
    id: MONITOR_SCREEN_ID,
    title: "Agent monitor",
    Component: (props: PluginScreenProps) => (
      <AgentMonitor
        {...props}
        bucketParam={props.params.bucket}
        agentParam={props.params.agent}
        openAgentToken={props.params.openAgent}
        viewParam={props.params.view}
        onOpenSettings={() => client.openSettings("monitor")}
      />
    ),
  });
  const removeSidebarItem = client.addSidebarHeaderItem({
    id: "monitor",
    title: "Agent monitor",
    Component: MonitorSidebarItem,
  });

  const removeOpenMonitor = client.addCommandCenterItem({
    id: "open-monitor",
    title: "Open agent monitor",
    icon: "Radar",
    keywords: ["agents", "sessions", "monitor", "triage"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: MONITOR_SCREEN_ID });
    },
  });
  const removeNextCommand = client.addCommandCenterItem({
    id: "cycle-next-agent",
    title: "Next agent",
    icon: "ChevronRight",
    keywords: ["next", "cycle", "agent", "switch", "keyboard"],
    context: "global",
    onSelect({ openScreen }) {
      const token = String(Date.now());
      const target = stepCycle(1);
      if (!target) {
        openScreen({ screenId: MONITOR_SCREEN_ID, params: { view: OVERVIEW_VIEW_PARAM } });
        return;
      }
      requestAgentOpen({ agentId: target.agentId, serverId: target.serverId, token });
      openScreen({ screenId: MONITOR_SCREEN_ID, params: { openAgent: token } });
    },
  });
  const removePreviousCommand = client.addCommandCenterItem({
    id: "cycle-previous-agent",
    title: "Previous agent",
    icon: "ChevronLeft",
    keywords: ["previous", "cycle", "agent", "switch", "keyboard"],
    context: "global",
    onSelect({ openScreen }) {
      const token = String(Date.now());
      const target = stepCycle(-1);
      if (!target) {
        openScreen({ screenId: MONITOR_SCREEN_ID, params: { view: OVERVIEW_VIEW_PARAM } });
        return;
      }
      requestAgentOpen({ agentId: target.agentId, serverId: target.serverId, token });
      openScreen({ screenId: MONITOR_SCREEN_ID, params: { openAgent: token } });
    },
  });
  const removeOverviewCommand = client.addCommandCenterItem({
    id: "open-overview",
    title: "Agent overview",
    icon: "Grid",
    keywords: ["overview", "switch", "mission control", "attention", "keyboard"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: MONITOR_SCREEN_ID, params: { view: OVERVIEW_VIEW_PARAM } });
    },
  });
  const removeConfigureMonitor = client.addCommandCenterItem({
    id: "configure-monitor",
    title: "Configure agent monitor",
    icon: "Settings",
    keywords: ["settings", "preferences", "monitor"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("monitor");
    },
  });

  return () => {
    removeConfigureMonitor();
    removePreviousCommand();
    removeNextCommand();
    removeOverviewCommand();
    removeOpenMonitor();
    removeSidebarItem();
    removeScreen();
    removeSettings();
  };
}
