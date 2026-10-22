import { describe, expect, test } from "vitest";
import type { InteractionData } from "../client/graph";
import { buildGraph } from "../client/graph";
import { mergeHostInteractions } from "../client/graph-data";
import {
  type AgentEntry,
  baseProjectName,
  type GroupOptions,
  groupByProject,
  HOST_PALETTE,
  type HostScope,
  hostColor,
  hostOf,
  indexProjects,
  type MonitorDirectory,
  matches,
  mergeProjectGroupsAcrossHosts,
  type WorkspaceSummary,
  withHostScope,
} from "../client/monitor";
import { mergeHostDirectories } from "../client/monitor-data";

const ANTODESK: HostScope = { serverId: "srv-antodesk", label: "antodesk" };
const MAC: HostScope = { serverId: "srv-macomac", label: "antomac" };
const OPTIONS: GroupOptions = { floatPinned: false, agentSort: "title" };

type AgentOverrides = Partial<AgentEntry["agent"]>;
type ProjectOverrides = Partial<AgentEntry["project"]>;

function entry(agent: AgentOverrides = {}, project: ProjectOverrides = {}): AgentEntry {
  return {
    agent: {
      id: "agent-123456",
      provider: "codex",
      cwd: "/work/project",
      workspaceId: "workspace-1",
      model: "gpt-5",
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T11:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {},
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: "Agent title",
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      ...agent,
    },
    project: {
      projectKey: "project-1",
      projectName: "Project",
      workspaceName: "Workspace",
      checkout: {
        cwd: "/work/project",
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
      ...project,
    },
  } as AgentEntry;
}

function workspace(id: string, name: string, projectId: string): WorkspaceSummary {
  return {
    id,
    navigationId: id,
    name,
    projectId,
    projectName: name,
    pinned: false,
    labels: [],
    additions: 0,
    deletions: 0,
  };
}

function interactions(overrides: Partial<InteractionData> = {}): InteractionData {
  return {
    messagesByAgent: new Map(),
    edges: [],
    subagents: [],
    ...overrides,
  };
}

describe("host scope", () => {
  test("tags entries and reads the scope back", () => {
    expect(hostOf(entry())).toBeUndefined();
    const scoped = withHostScope(entry(), ANTODESK);
    expect(hostOf(scoped)).toEqual(ANTODESK);
  });

  test("search matches the host label", () => {
    expect(matches(withHostScope(entry(), ANTODESK), "antodesk")).toBe(true);
    expect(matches(withHostScope(entry(), ANTODESK), "antomac")).toBe(false);
  });
});

describe("attention quick access", () => {
  test("carries host and provider detail for the popover", async () => {
    const { attentionItems } = await import("../client/monitor");
    const items = attentionItems([
      withHostScope(
        entry({ id: "a", requiresAttention: true, provider: "claude", model: "opus" }),
        ANTODESK,
      ),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].host?.label).toBe("antodesk");
    expect(items[0].detail).toBe("claude · opus");
  });
});

describe("layout panels", () => {
  test("initial cluster panels never overlap, however many hosts share a project", () => {
    const projects = ["FINTERLACE", "fluxcow", "FLUXRIG", "infra", "intel", "knowledge", "QUINCE"];
    const scoped = projects.flatMap((project) =>
      [MAC, ANTODESK].map((host, hostIndex) =>
        withHostScope(
          entry(
            { id: `${project}-${hostIndex}`, workspaceId: `ws-${project}-${hostIndex}` },
            { projectKey: project.toLowerCase(), projectName: project, workspaceName: "general" },
          ),
          host,
        ),
      ),
    );
    // A couple of crowded panels, like production.
    for (let i = 0; i < 6; i += 1) {
      scoped.push(
        withHostScope(
          entry(
            { id: `fluxrig-extra-${i}`, workspaceId: `ws-fluxrig-extra-${i}` },
            { projectKey: "fluxrig", projectName: "FLUXRIG", workspaceName: "general" },
          ),
          ANTODESK,
        ),
      );
    }
    const layout = buildGraph(scoped, {
      messagesByAgent: new Map(),
      edges: [],
      subagents: [],
    });
    for (const [aIndex, a] of layout.clusters.entries()) {
      for (const b of layout.clusters.slice(aIndex + 1)) {
        const separated =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(separated, `${a.key} overlaps ${b.key}`).toBe(true);
      }
    }
  });
});

describe("focus request", () => {
  test("peek keeps the request, take consumes it", async () => {
    const { peekAgentFocus, requestAgentFocus, takeAgentFocus } = await import(
      "../client/focus-request"
    );
    requestAgentFocus("agent-1");
    expect(peekAgentFocus()).toBe("agent-1");
    expect(peekAgentFocus()).toBe("agent-1");
    expect(takeAgentFocus()).toBe("agent-1");
    expect(peekAgentFocus()).toBeNull();
  });
});

describe("hostColor", () => {
  test("is stable per server and comes from the shared palette", () => {
    expect(hostColor(ANTODESK)).toBe(hostColor(ANTODESK));
    expect(HOST_PALETTE).toContain(hostColor(ANTODESK));
    expect(HOST_PALETTE).toContain(hostColor(MAC));
  });
});

describe("baseProjectName", () => {
  test("strips a per-host suffix", () => {
    expect(baseProjectName("FINTERLACE · mac")).toBe("FINTERLACE");
  });

  test("keeps plain names", () => {
    expect(baseProjectName("infra")).toBe("infra");
  });
});

describe("mergeHostDirectories", () => {
  test("tags entries per host and merges directories", () => {
    const macEntry = entry({ id: "mac-1", workspaceId: "ws-mac" });
    const deskEntry = entry({ id: "desk-1", workspaceId: "ws-desk" });
    const merged = mergeHostDirectories([
      {
        host: MAC,
        data: {
          entries: [macEntry],
          directory: {
            workspaces: new Map([["ws-mac", workspace("ws-mac", "infra", "prj-mac")]]),
            projects: indexProjects([]),
          },
          truncated: false,
        },
      },
      {
        host: ANTODESK,
        data: {
          entries: [deskEntry],
          directory: {
            workspaces: new Map([["ws-desk", workspace("ws-desk", "infra", "prj-desk")]]),
            projects: indexProjects([]),
          },
          truncated: true,
        },
      },
    ]);

    expect(merged.entries.map((item) => item.agent.id)).toEqual(["mac-1", "desk-1"]);
    expect(hostOf(merged.entries[0])?.serverId).toBe(MAC.serverId);
    expect(hostOf(merged.entries[1])?.serverId).toBe(ANTODESK.serverId);
    expect([...merged.directory.workspaces.keys()].sort()).toEqual(["ws-desk", "ws-mac"]);
    expect(merged.truncated).toBe(true);
  });
});

describe("mergeHostInteractions", () => {
  test("concatenates edges and sums message counts", () => {
    const merged = mergeHostInteractions([
      interactions({
        messagesByAgent: new Map([["a", 2]]),
        edges: [{ from: "a", to: "b", count: 1, kind: "tree" }],
        subagents: [{ parentId: "a", id: "sub:a:x", label: "x", kind: "task", count: 1 }],
        unreadable: 1,
      }),
      interactions({
        messagesByAgent: new Map([["a", 3]]),
        edges: [{ from: "c", to: "d", count: 1, kind: "message" }],
        unreadable: 0,
      }),
    ]);

    expect(merged.messagesByAgent.get("a")).toBe(5);
    expect(merged.edges).toHaveLength(2);
    expect(merged.subagents).toHaveLength(1);
    expect(merged.unreadable).toBe(1);
  });
});

describe("mergeProjectGroupsAcrossHosts", () => {
  function directoryFor(projectId: string, projectName: string): MonitorDirectory {
    return {
      workspaces: new Map(),
      projects: indexProjects([{ id: projectId, name: projectName }]),
    };
  }

  test("merges a renamed project with its base name", () => {
    const macEntries = [
      withHostScope(
        entry(
          { id: "mac-1", workspaceId: "ws-mac" },
          { projectKey: "finterlace", projectName: "FINTERLACE · mac", workspaceName: "general" },
        ),
        MAC,
      ),
    ];
    const deskEntries = [
      withHostScope(
        entry(
          { id: "desk-1", workspaceId: "ws-desk" },
          { projectKey: "finterlace", projectName: "FINTERLACE", workspaceName: "general" },
        ),
        ANTODESK,
      ),
    ];
    const merged = mergeProjectGroupsAcrossHosts([
      {
        host: MAC,
        projects: groupByProject(macEntries, directoryFor("prj-mac", "FINTERLACE · mac"), OPTIONS),
      },
      {
        host: ANTODESK,
        projects: groupByProject(deskEntries, directoryFor("prj-desk", "FINTERLACE"), OPTIONS),
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("FINTERLACE");
    expect(
      merged[0].workspaces.flatMap((group) => group.entries.map((item) => item.agent.id)).sort(),
    ).toEqual(["desk-1", "mac-1"]);
  });

  test("keeps distinct projects apart and sorts by name", () => {
    const merged = mergeProjectGroupsAcrossHosts([
      {
        host: MAC,
        projects: groupByProject(
          [entry({ id: "m1", workspaceId: "ws-infra" }, { projectName: "infra" })],
          {
            workspaces: new Map([["ws-infra", workspace("ws-infra", "infra", "prj-infra")]]),
            projects: indexProjects([{ id: "prj-infra", name: "infra" }]),
          },
          OPTIONS,
        ),
      },
      {
        host: ANTODESK,
        projects: groupByProject(
          [entry({ id: "d1", workspaceId: "ws-intel" }, { projectName: "intel" })],
          {
            workspaces: new Map([["ws-intel", workspace("ws-intel", "intel", "prj-intel")]]),
            projects: indexProjects([{ id: "prj-intel", name: "intel" }]),
          },
          OPTIONS,
        ),
      },
    ]);

    expect(merged.map((project) => project.name)).toEqual(["infra", "intel"]);
  });
});

describe("multi-host graph", () => {
  test("shares one panel per project and records each node's host", () => {
    const layout = buildGraph(
      [
        withHostScope(
          entry({ id: "mac-1" }, { projectName: "FINTERLACE · mac", workspaceName: "general" }),
          MAC,
        ),
        withHostScope(
          entry({ id: "desk-1" }, { projectName: "FINTERLACE", workspaceName: "general" }),
          ANTODESK,
        ),
      ],
      interactions(),
    );

    expect(layout.nodes).toHaveLength(2);
    expect(new Set(layout.nodes.map((node) => node.colorKey)).size).toBe(1);
    expect(layout.clusters).toHaveLength(1);
    expect(layout.clusters[0].name).toBe("FINTERLACE / general");
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    expect(byId.get("mac-1")?.host?.label).toBe("antomac");
    expect(byId.get("desk-1")?.host?.label).toBe("antodesk");
  });
});
