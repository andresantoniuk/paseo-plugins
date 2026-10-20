import { describe, expect, test } from "vitest";
import { type MonitorSettingsState, settingsAreReady } from "../client/settings-state";
import {
  DEFAULT_BUCKET_OPTIONS,
  DEFAULT_SETTINGS,
  initialBucket,
  monitorSettings,
} from "../shared/monitor-settings";

describe("monitor settings document", () => {
  test("is host-scoped and supplies a complete default document", () => {
    expect(monitorSettings.id).toBe("monitor");
    expect(monitorSettings.scope).toBe("host");
    expect(monitorSettings.version).toBe(2);
    expect(monitorSettings.schema.parse({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_BUCKET_OPTIONS.map(({ id }) => id)).toEqual([
      "all",
      "attention",
      "running",
      "idle",
      "closed",
    ]);
  });

  test("fills the bucket only when an older document never stored it", () => {
    expect(monitorSettings.migrate?.({ showModel: false }, 1)).toMatchObject({
      defaultBucket: "attention",
      showModel: false,
    });
    expect(monitorSettings.migrate?.({ defaultBucket: "all" }, 1)).toMatchObject({
      defaultBucket: "all",
    });
    expect(monitorSettings.migrate?.({ defaultBucket: "closed" }, 1)).toMatchObject({
      defaultBucket: "closed",
    });
  });

  test("accepts complete typed overrides and rejects invalid values", () => {
    expect(
      monitorSettings.schema.parse({
        grouping: "compact",
        agentSort: "title",
        density: "compact",
        defaultBucket: "closed",
        floatPinned: false,
        showAge: false,
        hideClosedUnlessFiltered: true,
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      grouping: "compact",
      agentSort: "title",
      density: "compact",
      defaultBucket: "closed",
      floatPinned: false,
      showAge: false,
      hideClosedUnlessFiltered: true,
    });
    expect(() => monitorSettings.schema.parse({ grouping: "galaxy" })).toThrow();
  });
});

describe("settings readiness", () => {
  test("allows the roster only for a ready settings document", () => {
    expect(settingsAreReady({ status: "loading" } as unknown as MonitorSettingsState)).toBe(false);
    expect(settingsAreReady({ status: "error" } as unknown as MonitorSettingsState)).toBe(false);
    expect(settingsAreReady({ status: "invalid" } as unknown as MonitorSettingsState)).toBe(false);
    expect(settingsAreReady({ status: "ready" } as unknown as MonitorSettingsState)).toBe(true);
  });
});

describe("initialBucket", () => {
  test("maps all and explicit defaults", () => {
    expect(initialBucket({ ...DEFAULT_SETTINGS, defaultBucket: "all" })).toBe(null);
    expect(initialBucket({ ...DEFAULT_SETTINGS, defaultBucket: "attention" })).toBe("attention");
    expect(initialBucket({ ...DEFAULT_SETTINGS, defaultBucket: "closed" })).toBe("closed");
  });
});
