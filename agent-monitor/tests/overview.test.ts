import { describe, expect, test } from "vitest";
import type { AgentEntry, HostScope } from "../client/monitor";
import { withHostScope } from "../client/monitor";
import { digitIndex, moveSelection, overviewItems } from "../client/overview";

function entry(
  id: string,
  agent: Partial<AgentEntry["agent"]> = {},
  project: Partial<AgentEntry["project"]> = {},
): AgentEntry {
  return {
    agent: {
      id,
      title: id,
      provider: "claude",
      status: "idle",
      updatedAt: "2026-08-25T11:00:00.000Z",
      attentionTimestamp: null,
      requiresAttention: false,
      pendingPermissions: [],
      ...agent,
    },
    project: { projectKey: "p", projectName: "P", ...project },
  } as AgentEntry;
}

const HOST: HostScope = { serverId: "srv-a", label: "alpha" };

describe("overviewItems", () => {
  test("lists attention first by wait, then running by title, skipping the rest", () => {
    const items = overviewItems([
      withHostScope(entry("idle-1"), HOST),
      entry("run-b", { status: "running" }),
      entry("run-a", { status: "running" }),
      entry("closed-1", { status: "closed" }),
      entry("new-attention", {
        requiresAttention: true,
        attentionTimestamp: "2026-08-25T12:00:00.000Z",
      }),
      withHostScope(
        entry("old-attention", {
          requiresAttention: true,
          attentionTimestamp: "2026-08-25T10:00:00.000Z",
        }),
        HOST,
      ),
    ]);

    expect(items.map((item) => item.id)).toEqual([
      "old-attention",
      "new-attention",
      "run-a",
      "run-b",
    ]);
    expect(items[0].needsAttention).toBe(true);
    expect(items[0].host).toEqual(HOST);
    expect(items[2].needsAttention).toBe(false);
  });
});

describe("moveSelection", () => {
  test("wraps around both ends and handles emptiness", () => {
    expect(moveSelection(0, 3, 1)).toBe(1);
    expect(moveSelection(2, 3, 1)).toBe(0);
    expect(moveSelection(0, 3, -1)).toBe(2);
    expect(moveSelection(0, 0, 1)).toBe(-1);
    expect(moveSelection(-1, 3, 1)).toBe(0);
    expect(moveSelection(-1, 3, -1)).toBe(2);
  });
});

describe("digitIndex", () => {
  test("maps 1-9 to indexes and rejects the rest", () => {
    expect(digitIndex("1")).toBe(0);
    expect(digitIndex("9")).toBe(8);
    expect(digitIndex("0")).toBeNull();
    expect(digitIndex("Enter")).toBeNull();
  });
});
