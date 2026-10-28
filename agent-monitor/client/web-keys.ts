import { useEffect } from "react";

export type WebKeyTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

export type WebKeyEvent = {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
  target: WebKeyTarget | null;
};

type WebWindow = {
  addEventListener(type: "keydown", listener: (event: WebKeyEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: WebKeyEvent) => void): void;
};

function webWindow(): WebWindow | null {
  const candidate = (globalThis as { window?: unknown }).window;
  return candidate !== null && typeof candidate === "object" ? (candidate as WebWindow) : null;
}

/** True when the keydown started in an editable element. Escape is never typing. */
export function isTyping(target: WebKeyTarget | null, key: string): boolean {
  if (key === "Escape") return false;
  if (!target || typeof target.tagName !== "string") return false;
  return (
    target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable === true
  );
}

/** Window keydown listener (web only). Re-subscribes when the handler changes. */
export function useKeyDown(handler: (event: WebKeyEvent) => void): void {
  useEffect(() => {
    const win = webWindow();
    if (!win) return;
    const onKeyDown = (event: WebKeyEvent) => {
      if (isTyping(event.target, event.key)) return;
      handler(event);
    };
    win.addEventListener("keydown", onKeyDown);
    return () => win.removeEventListener("keydown", onKeyDown);
  }, [handler]);
}
