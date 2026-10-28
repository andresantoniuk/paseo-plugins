import { afterEach, describe, expect, test, vi } from "vitest";
import { useKeyDown, type WebKeyEvent } from "../client/web-keys";

vi.mock("react", () => ({
  useEffect: (effect: () => undefined | (() => void)) => {
    effect();
  },
}));

function keydown(overrides: Partial<WebKeyEvent>): WebKeyEvent {
  return { key: "r", shiftKey: false, preventDefault: () => {}, target: null, ...overrides };
}

describe("useKeyDown", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("leaves browser chords and typing alone, but passes Shift", () => {
    let listener: ((event: WebKeyEvent) => void) | undefined;
    vi.stubGlobal("window", {
      addEventListener: (_type: string, handler: (event: WebKeyEvent) => void) => {
        listener = handler;
      },
      removeEventListener: () => {},
    });
    const handler = vi.fn();
    useKeyDown(handler);

    listener?.(keydown({ ctrlKey: true }));
    listener?.(keydown({ metaKey: true }));
    listener?.(keydown({ altKey: true }));
    listener?.(keydown({ target: { tagName: "INPUT" } }));
    expect(handler).not.toHaveBeenCalled();

    listener?.(keydown({ key: "Tab", shiftKey: true }));
    listener?.(keydown({ key: "Escape", target: { tagName: "TEXTAREA" } }));
    expect(handler.mock.calls.map(([event]) => event.key)).toEqual(["Tab", "Escape"]);
  });
});
