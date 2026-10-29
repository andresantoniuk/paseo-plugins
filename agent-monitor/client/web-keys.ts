import { useEffect } from "react";

export type WebKeyTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

export type WebKeyEvent = {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  preventDefault(): void;
  target: WebKeyTarget | null;
};

type WebWindow = {
  addEventListener(type: "keydown", listener: (event: WebKeyEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: WebKeyEvent) => void): void;
};

function webWindow(): WebWindow | null {
  const candidate = (globalThis as { window?: Partial<WebWindow> | null }).window;
  // Having a `window` object is not enough: React Native defines one with no addEventListener, and calling it threw
  // "undefined is not a function", which failed the whole plugin on Android. Use it only if it can listen.
  return candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
    ? (candidate as WebWindow)
    : null;
}

/** True when the keydown started in an editable element. Escape is never typing. */
export function isTyping(target: WebKeyTarget | null, key: string): boolean {
  if (key === "Escape") return false;
  if (!target || typeof target.tagName !== "string") return false;
  return (
    target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable === true
  );
}

// Mounted modal listeners (the quick-access popover). While any is mounted, it
// owns the keyboard and the screens underneath stop handling keys.
let modalOwners = 0;

/**
 * Window keydown listener (web only). Re-subscribes when the handler changes.
 * Ctrl, Meta and Alt chords belong to the browser and app (reload, copy), so
 * they never reach the handler. A `modal` listener takes the keyboard from the
 * others while it is mounted, so one key never drives two surfaces.
 */
export function useKeyDown(handler: (event: WebKeyEvent) => void, modal = false): void {
  useEffect(() => {
    const win = webWindow();
    if (!win) return;
    if (modal) modalOwners += 1;
    const onKeyDown = (event: WebKeyEvent) => {
      if (!modal && modalOwners > 0) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event.target, event.key)) return;
      handler(event);
    };
    win.addEventListener("keydown", onKeyDown);
    return () => {
      win.removeEventListener("keydown", onKeyDown);
      if (modal) modalOwners -= 1;
    };
  }, [handler, modal]);
}
