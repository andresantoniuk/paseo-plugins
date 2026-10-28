import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useKeyDown, type WebKeyEvent } from "../client/web-keys";

const effects = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));

vi.mock("react", () => ({
  useEffect: (effect: () => undefined | (() => void)) => {
    const cleanup = effect();
    if (cleanup) effects.cleanups.push(cleanup);
  },
}));

type Listener = (event: WebKeyEvent) => void;
let listeners: Listener[] = [];

function press(overrides: Partial<WebKeyEvent>): void {
  const event = { key: "r", shiftKey: false, preventDefault: () => {}, target: null, ...overrides };
  for (const listener of [...listeners]) listener(event);
}

describe("useKeyDown", () => {
  beforeEach(() => {
    listeners = [];
    vi.stubGlobal("window", {
      addEventListener: (_type: string, handler: Listener) => listeners.push(handler),
      removeEventListener: (_type: string, handler: Listener) => {
        listeners = listeners.filter((candidate) => candidate !== handler);
      },
    });
  });

  afterEach(() => {
    for (const cleanup of effects.cleanups.splice(0)) cleanup();
    vi.unstubAllGlobals();
  });

  test("leaves browser chords and typing alone, but passes Shift", () => {
    const handler = vi.fn();
    useKeyDown(handler);

    press({ ctrlKey: true });
    press({ metaKey: true });
    press({ altKey: true });
    press({ target: { tagName: "INPUT" } });
    expect(handler).not.toHaveBeenCalled();

    press({ key: "Tab", shiftKey: true });
    press({ key: "Escape", target: { tagName: "TEXTAREA" } });
    expect(handler.mock.calls.map(([event]) => event.key)).toEqual(["Tab", "Escape"]);
  });

  test("a mounted modal listener owns the keyboard until it unmounts", () => {
    const screen = vi.fn();
    const popover = vi.fn();
    useKeyDown(screen);
    useKeyDown(popover, true);

    press({ key: "1" });
    expect(popover).toHaveBeenCalledTimes(1);
    expect(screen).not.toHaveBeenCalled();

    effects.cleanups.pop()?.();
    press({ key: "1" });
    expect(screen).toHaveBeenCalledTimes(1);
  });

  test("does not throw where window exists without keyboard events (React Native)", () => {
    // React Native defines `window` as an object, but it has no addEventListener. Calling it threw
    // "undefined is not a function" and the whole plugin failed on Android.
    vi.stubGlobal("window", {});
    expect(() => useKeyDown(vi.fn())).not.toThrow();
    expect(() => useKeyDown(vi.fn(), true)).not.toThrow();
  });

  test("a window with only addEventListener is not used either, so cleanup cannot throw", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    expect(() => useKeyDown(vi.fn())).not.toThrow();
  });
});
