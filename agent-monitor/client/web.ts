import { Platform } from "react-native";

export type WheelInput = {
  preventDefault?: () => void;
  deltaY?: number;
  ctrlKey?: boolean;
};

type WheelListener = (event: WheelInput) => void;

// Structural, so no DOM lib types or globals leak into native bundles.
type WheelTarget = {
  addEventListener?: (
    name: "wheel",
    listener: WheelListener,
    options?: { passive: boolean },
  ) => void;
  removeEventListener?: (name: "wheel", listener: WheelListener) => void;
};

/**
 * Listens for wheel events on a web element with a non-passive listener, so
 * the handler can preventDefault and stop the page from scrolling. Returns the
 * matching cleanup, or undefined when there is nothing to attach to (native,
 * no element yet, or an element without DOM listeners).
 */
export function onWheel(element: unknown, listener: WheelListener): (() => void) | undefined {
  if (Platform.OS !== "web") return undefined;
  const target = element as WheelTarget | null;
  if (!target?.addEventListener || !target.removeEventListener) return undefined;
  target.addEventListener("wheel", listener, { passive: false });
  return () => target.removeEventListener?.("wheel", listener);
}
