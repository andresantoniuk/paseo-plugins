import { beforeEach, describe, expect, test, vi } from "vitest";
import { createPressGuard, isDrag } from "../client/gesture";
import { onWheel } from "../client/web";

const platform = vi.hoisted(() => ({ OS: "web" }));
vi.mock("react-native", () => ({ Platform: platform }));

function element() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    addEventListener: vi.fn((_name: string, listener: (event: unknown) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_name: string, listener: (event: unknown) => void) => {
      listeners.delete(listener);
    }),
  };
}

describe("wheel adapter", () => {
  beforeEach(() => {
    platform.OS = "web";
  });

  test("attaches a non-passive wheel listener and removes the same listener", () => {
    const canvas = element();
    const listener = vi.fn();

    const cleanup = onWheel(canvas, listener);
    expect(canvas.addEventListener).toHaveBeenCalledWith("wheel", listener, { passive: false });
    expect(canvas.listeners.has(listener)).toBe(true);

    cleanup?.();
    expect(canvas.removeEventListener).toHaveBeenCalledWith("wheel", listener);
    expect(canvas.listeners.size).toBe(0);
  });

  test("a replacement canvas element gets its own listener after the first is gone", () => {
    const first = element();
    const second = element();
    const listener = vi.fn();

    onWheel(first, listener)?.();
    const cleanup = onWheel(second, listener);

    expect(first.listeners.size).toBe(0);
    expect(second.listeners.has(listener)).toBe(true);
    cleanup?.();
    expect(second.listeners.size).toBe(0);
  });

  test("does nothing off web, before the element exists, or without DOM listeners", () => {
    const canvas = element();
    platform.OS = "ios";
    expect(onWheel(canvas, vi.fn())).toBeUndefined();
    expect(canvas.addEventListener).not.toHaveBeenCalled();

    platform.OS = "web";
    expect(onWheel(null, vi.fn())).toBeUndefined();
    expect(onWheel({}, vi.fn())).toBeUndefined();
  });
});

describe("drag versus press", () => {
  test("small pointer jitter is a tap, motion beyond the threshold is a drag", () => {
    expect(isDrag(0, 0)).toBe(false);
    expect(isDrag(3, -3)).toBe(false);
    expect(isDrag(4, 0)).toBe(true);
    expect(isDrag(0, -4)).toBe(true);
  });

  test("a press activates when nothing was dragged", () => {
    const guard = createPressGuard();
    guard.reset();
    expect(guard.consume()).toBe(true);
  });

  test("the click that follows a drag is swallowed once, then presses work again", () => {
    const guard = createPressGuard();
    guard.reset();
    guard.markDragged();

    expect(guard.consume()).toBe(false);
    expect(guard.consume()).toBe(true);
  });

  test("a new press clears a drag whose click never arrived", () => {
    const guard = createPressGuard();
    guard.markDragged();
    guard.reset();

    expect(guard.consume()).toBe(true);
  });
});
