import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent, RefObject } from "react";

export type SheetHeight = "peek" | "half" | "full";

/** A preset size: a value above 1 is pixels, otherwise a fraction of the viewport. */
export type SheetPresets = Record<SheetHeight, number>;

/** Movement, in px, before a press becomes a drag (below it, it is a tap). */
const DRAG_PX = 6;
/** A release this close to a preset snaps to it. */
const SNAP_PX = 24;
/** Fired when a drag ends so map obstacles re-measure once. */
export const OBSTACLES_REFRESH_EVENT = "ptn:obstacles-refresh";
/** Set on <html> while a sheet is being dragged; obstacle tracking pauses. */
export const SHEET_DRAGGING_ATTR = "data-sheet-dragging";

const ORDER: SheetHeight[] = ["peek", "half", "full"];

const toPx = (v: number) => (v > 1 ? v : v * window.innerHeight);
const toCss = (v: number) => (v > 1 ? `${v}px` : `${v * 100}vh`);

type SheetState = { kind: "preset"; height: SheetHeight } | { kind: "free"; px: number };

/**
 * Bottom-sheet sizing. Dragging the grab area (handle plus header) resizes the
 * sheet to any height; the release snaps to a preset only when close to one.
 * Tapping a non-control part of the grab area cycles the presets.
 *
 * Performance: while dragging, the height is written straight to the sheet's
 * style once per animation frame, so React does not re-render and only the
 * sheet itself is laid out. Map obstacle tracking pauses for the drag and
 * re-measures once on release. `height` (peek/half/full) is the nearest preset
 * and only changes on release; it gates which content renders.
 */
export function useSheetResize(
  sheetRef: RefObject<HTMLElement | null>,
  presets: SheetPresets,
  initial: SheetHeight = "half",
) {
  const [state, setState] = useState<SheetState>({ kind: "preset", height: initial });
  const presetsRef = useRef(presets);
  presetsRef.current = presets;

  const press = useRef<{ y: number; id: number; startPx: number } | null>(null);
  const dragging = useRef(false);
  const swiped = useRef(false);
  const frame = useRef(0);
  const pending = useRef<number | null>(null);
  const live = useRef<number | null>(null);

  const bounds = useCallback(() => {
    const p = presetsRef.current;
    return { min: toPx(p.peek), max: toPx(p.full) };
  }, []);

  const nearest = useCallback((px: number): SheetHeight => {
    const p = presetsRef.current;
    const peek = toPx(p.peek), half = toPx(p.half), full = toPx(p.full);
    if (px < (peek + half) / 2) return "peek";
    return px < (half + full) / 2 ? "half" : "full";
  }, []);

  const height: SheetHeight = state.kind === "preset" ? state.height : nearest(state.px);
  const style: CSSProperties = {
    maxHeight: state.kind === "preset" ? toCss(presets[state.height]) : `${state.px}px`,
  };

  const cycle = useCallback(() => {
    setState((s) => {
      const h = s.kind === "preset" ? s.height : nearest(s.px);
      return { kind: "preset", height: ORDER[(ORDER.indexOf(h) + 1) % ORDER.length] };
    });
  }, [nearest]);

  const finish = useCallback(() => {
    if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
    const el = sheetRef.current;
    const px = live.current;
    press.current = null;
    pending.current = null;
    live.current = null;
    if (!dragging.current) return;
    dragging.current = false;
    document.documentElement.removeAttribute(SHEET_DRAGGING_ATTR);
    if (el) el.style.transition = "";
    if (px !== null) {
      const p = presetsRef.current;
      const snap = ORDER.find((h) => Math.abs(toPx(p[h]) - px) <= SNAP_PX);
      // React only rewrites the style when its own value changes, so write the
      // settled value here too (a snap back to the unchanged preset is a no-op there).
      if (el) el.style.maxHeight = snap ? toCss(p[snap]) : `${px}px`;
      setState(snap ? { kind: "preset", height: snap } : { kind: "free", px });
    }
    window.dispatchEvent(new Event(OBSTACLES_REFRESH_EVENT));
  }, [sheetRef]);

  // A sheet that unmounts mid-drag must not leave obstacle tracking paused.
  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current);
    if (dragging.current) {
      document.documentElement.removeAttribute(SHEET_DRAGGING_ATTR);
      window.dispatchEvent(new Event(OBSTACLES_REFRESH_EVENT));
    }
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = sheetRef.current;
    press.current = { y: e.clientY, id: e.pointerId, startPx: el ? el.getBoundingClientRect().height : 0 };
    swiped.current = false;
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const s = press.current;
    const el = sheetRef.current;
    if (!s || s.id !== e.pointerId || !el) return;
    const dy = e.clientY - s.y;
    if (!dragging.current) {
      if (Math.abs(dy) < DRAG_PX) return;
      dragging.current = true;
      swiped.current = true;
      document.documentElement.setAttribute(SHEET_DRAGGING_ATTR, "");
      el.style.transition = "none";
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    }
    const { min, max } = bounds();
    pending.current = Math.round(Math.min(max, Math.max(min, s.startPx - dy)));
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        if (pending.current === null) return;
        live.current = pending.current;
        el.style.maxHeight = `${pending.current}px`;
      });
    }
  };

  const onPointerUp = () => {
    // Apply the last position even if its frame has not run yet.
    if (dragging.current && pending.current !== null) {
      live.current = pending.current;
      const el = sheetRef.current;
      if (el) el.style.maxHeight = `${pending.current}px`;
    }
    finish();
  };

  const onClick = (e: MouseEvent<HTMLElement>) => {
    if (swiped.current) { swiped.current = false; return; }
    const control = (e.target as Element).closest("button, a, input, select, [role='button']");
    if (control && !control.hasAttribute("data-sheet-handle")) return;
    cycle();
  };

  return {
    height,
    /** Spread on the sheet's root element. */
    sheetProps: { style },
    /** Spread on the wrapper around the handle and header. */
    grabProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onClick,
      // The grab area owns vertical gestures; the sheet body still scrolls.
      style: { touchAction: "none" } as CSSProperties,
    },
  };
}
