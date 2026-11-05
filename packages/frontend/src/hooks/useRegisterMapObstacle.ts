import { useCallback, useEffect, useRef } from "react";
import { useMapObstaclesStore } from "../stores/mapObstaclesStore.ts";

/**
 * Register a DOM element as a "map obstacle" — a UI overlay rectangle that
 * marker placement should treat as off-limits. Returns a `ref` to attach to
 * the element. The rectangle is tracked through ResizeObserver and window
 * resize events; on unmount the registration is cleared.
 *
 * @param id stable identifier (one per UI element)
 * @param enabled set false to skip registration (e.g. component is hidden via prop)
 */
export function useRegisterMapObstacle<T extends HTMLElement>(
  id: string,
  enabled = true,
) {
  const elRef = useRef<T | null>(null);

  const update = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    useMapObstaclesStore.getState().setObstacle(id, {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
    });
  }, [id]);

  useEffect(() => {
    if (!enabled) {
      useMapObstaclesStore.getState().clearObstacle(id);
      return;
    }
    const el = elRef.current;
    if (!el) return;

    update();

    // ResizeObserver catches height/width changes (e.g. StepList peek/half/full
    // CSS transitions, popup content reflow). jsdom doesn't ship one, so fall
    // through to mount-only registration there — tests that mount the
    // component still get the initial rect captured.
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => update())
        : null;
    ro?.observe(el);

    // Position changes (mounting in different bottom anchor, viewport resize)
    // aren't picked up by ResizeObserver directly — fall back to window events.
    window.addEventListener("resize", update);

    // Some transitions move position without resizing (e.g. translate). Listen
    // to transitionend on the element to refresh.
    el.addEventListener("transitionend", update);

    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
      el.removeEventListener("transitionend", update);
      useMapObstaclesStore.getState().clearObstacle(id);
    };
  }, [id, enabled, update]);

  return elRef;
}
