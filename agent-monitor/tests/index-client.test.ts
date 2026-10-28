import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, test, vi } from "vitest";
import contribute from "../index.client";

vi.mock("../client/agent-monitor", () => ({ AgentMonitor: () => null }));
vi.mock("../client/settings-screen", () => ({ MonitorSettingsScreen: () => null }));
vi.mock("../client/sidebar", () => ({
  MONITOR_SCREEN_ID: "monitor",
  MonitorSidebarItem: () => null,
}));

function host() {
  const removed: string[] = [];
  const registered: string[] = [];
  const commands: Array<{ id: string; onSelect(capabilities: unknown): void }> = [];
  const register = (method: string) => (contribution: { id: string }) => {
    registered.push(`${method}:${contribution.id}`);
    return () => removed.push(`${method}:${contribution.id}`);
  };
  const client = {
    addSettingsScreen: register("addSettingsScreen"),
    addScreen: register("addScreen"),
    addSidebarHeaderItem: register("addSidebarHeaderItem"),
    addCommandCenterItem: (command: { id: string; onSelect(capabilities: unknown): void }) => {
      commands.push(command);
      return register("addCommandCenterItem")(command);
    },
  } as unknown as PluginClientContext;
  return { client, registered, removed, commands };
}

describe("client entry", () => {
  test("registers the monitor screen and header row under the saved-link ids, then removes all", () => {
    const { client, registered, removed } = host();

    const cleanup = contribute(client);
    expect(registered).toEqual([
      "addSettingsScreen:monitor",
      "addScreen:monitor",
      "addSidebarHeaderItem:monitor",
      "addCommandCenterItem:open-monitor",
      "addCommandCenterItem:cycle-next-agent",
      "addCommandCenterItem:cycle-previous-agent",
      "addCommandCenterItem:open-overview",
      "addCommandCenterItem:configure-monitor",
    ]);

    cleanup();
    expect(removed.sort()).toEqual([...registered].sort());
  });

  test("Open agent monitor navigates to the screen", () => {
    const { client, commands } = host();
    contribute(client);
    const openScreen = vi.fn();
    commands.find(({ id }) => id === "open-monitor")?.onSelect({ openScreen });
    expect(openScreen).toHaveBeenCalledWith({ screenId: "monitor" });
  });

  test("Agent overview opens the monitor in overview mode", () => {
    const { client, commands } = host();
    contribute(client);
    const openScreen = vi.fn();
    commands.find(({ id }) => id === "open-overview")?.onSelect({ openScreen });
    expect(openScreen).toHaveBeenCalledWith({ screenId: "monitor", params: { view: "overview" } });
  });

  test("Next agent hands off to the next target, wrapping around", async () => {
    const { setCycleList, takeAgentOpen } = await import("../client/focus-request");
    const { client, commands } = host();
    contribute(client);
    setCycleList([
      { agentId: "a", serverId: "srv-1" },
      { agentId: "b", serverId: "srv-2" },
    ]);
    const openScreen = vi.fn();
    const next = commands.find(({ id }) => id === "cycle-next-agent")?.onSelect;
    next?.({ openScreen });
    const first = takeAgentOpen();
    expect(first?.agentId).toBe("a");
    expect(openScreen).toHaveBeenCalledWith({
      screenId: "monitor",
      params: { openAgent: first?.token },
    });
    next?.({ openScreen });
    expect(takeAgentOpen()?.agentId).toBe("b");
    next?.({ openScreen });
    expect(takeAgentOpen()?.agentId).toBe("a");
  });

  test("Cycling with an empty list falls back to the overview", async () => {
    const { setCycleList, takeAgentOpen } = await import("../client/focus-request");
    const { client, commands } = host();
    contribute(client);
    setCycleList([]);
    const openScreen = vi.fn();
    commands.find(({ id }) => id === "cycle-previous-agent")?.onSelect({ openScreen });
    expect(openScreen).toHaveBeenCalledWith({ screenId: "monitor", params: { view: "overview" } });
    expect(takeAgentOpen()).toBeNull();
  });
});
