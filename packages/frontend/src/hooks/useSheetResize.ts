import { useCallback, useRef, useState } from "react";
import type { PointerEvent, MouseEvent } from "react";

export type SheetHeight = "peek" | "half" | "full";

const ORDER: SheetHeight[] = ["peek", "half", "full"];
/** Vertical travel, in px, before a drag counts as a swipe. */
const SWIPE_PX = 36;

/**
 * Height state for a bottom sheet that resizes by swiping its grab area
 * (handle plus header) up or down, or by tapping non-interactive parts of it.
 * Spread `grabProps` on the wrapper around the handle and header. Controls
 * inside it (close, favorite) keep their own clicks; the handle element, marked
 * `data-sheet-handle`, stays a keyboard-operable toggle.
 */
export function useSheetResize(initial: SheetHeight = "half") {
  const [height, setHeight] = useState<SheetHeight>(initial);
  const start = useRef<{ y: number; id: number } | null>(null);
  const swiped = useRef(false);

  const step = useCallback((dir: 1 | -1) => {
    setHeight((h) => ORDER[Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(h) + dir))]);
  }, []);

  const cycle = useCallback(() => {
    setHeight((h) => (h === "peek" ? "half" : h === "half" ? "full" : "peek"));
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    start.current = { y: e.clientY, id: e.pointerId };
    swiped.current = false;
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const dy = e.clientY - s.y;
    if (Math.abs(dy) < SWIPE_PX) return;
    swiped.current = true;
    start.current = null;
    step(dy < 0 ? 1 : -1);
  };
  const end = () => { start.current = null; };
  const onClick = (e: MouseEvent<HTMLElement>) => {
    if (swiped.current) { swiped.current = false; return; }
    const target = e.target as Element;
    const control = target.closest("button, a, input, select, [role='button']");
    if (control && !control.hasAttribute("data-sheet-handle")) return;
    cycle();
  };

  return {
    height,
    setHeight,
    grabProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onClick,
      // The grab area owns vertical gestures; the sheet body still scrolls.
      style: { touchAction: "none" as const },
    },
  };
}
