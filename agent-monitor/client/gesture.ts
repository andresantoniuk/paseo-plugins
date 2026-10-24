const DRAG_THRESHOLD = 3;

/** True once a pointer has travelled far enough to count as a drag, not a tap. */
export const isDrag = (dx: number, dy: number): boolean =>
  Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD;

export type PressGuard = {
  /** A new press began: any earlier drag no longer affects it. */
  reset(): void;
  /** The current pointer sequence turned into a drag. */
  markDragged(): void;
  /** Whether a press may activate. Consumes the drag flag. */
  consume(): boolean;
};

/**
 * Lets a draggable control keep native press semantics (pointer, keyboard,
 * screen reader) while dragging never activates it. On web the browser still
 * fires `click` on the element after a drag ends, which a Pressable reports as
 * `onPress`; this is the single place that swallows exactly that press.
 */
export function createPressGuard(): PressGuard {
  let dragged = false;
  return {
    reset() {
      dragged = false;
    },
    markDragged() {
      dragged = true;
    },
    consume() {
      const allowed = !dragged;
      dragged = false;
      return allowed;
    },
  };
}
