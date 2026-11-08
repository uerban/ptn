/**
 * The temporary map opened from Text mode.
 *
 * It is a history entry on the current route (`?view=map`), so the phone's
 * Back gesture and **Back to text** both return to the text screen instead of
 * leaving it. The saved starting view (`scheduleMode`) never changes.
 */
import { useCallback } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

export const TEMPORARY_MAP_PARAM = "view";
export const TEMPORARY_MAP_VALUE = "map";

/** Marks the history entry this app pushed, so closing can pop it. */
interface TemporaryMapState {
  temporaryMap?: true;
}

/**
 * The element (by `data-return-focus` value) that opened the map. Read once
 * by the text screen when it comes back, to put focus where the user was.
 * In memory only.
 */
let returnFocusTarget: string | null = null;

export function takeReturnFocusTarget(): string | null {
  const target = returnFocusTarget;
  returnFocusTarget = null;
  return target;
}

/** The element marked `data-return-focus="<name>"`, if rendered. */
export function findReturnFocus(name: string, doc: Document = document): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>("[data-return-focus]")) {
    if (el.dataset.returnFocus === name) return el;
  }
  return null;
}

/** Focus the element that opened the temporary map, once it is rendered. */
export function restoreReturnFocus(doc: Document = document): void {
  const target = takeReturnFocusTarget();
  if (!target) return;
  const tryFocus = (attempt: number) => {
    const el = findReturnFocus(target, doc);
    if (el) {
      el.focus();
      return;
    }
    if (attempt < 20) requestAnimationFrame(() => tryFocus(attempt + 1));
  };
  tryFocus(0);
}

export interface TemporaryMap {
  /** The URL asks for the temporary map. */
  active: boolean;
  /** Open the map as a new history entry; `returnFocus` names the opener. */
  open: (returnFocus?: string) => void;
  /** Back to text: pops the entry this app pushed, else drops the parameter. */
  close: () => void;
}

export function useTemporaryMap(): TemporaryMap {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const active = params.get(TEMPORARY_MAP_PARAM) === TEMPORARY_MAP_VALUE;
  const pushedHere = (location.state as TemporaryMapState | null)?.temporaryMap === true;

  const open = useCallback(
    (returnFocus?: string) => {
      returnFocusTarget = returnFocus ?? null;
      const next = new URLSearchParams(params);
      next.set(TEMPORARY_MAP_PARAM, TEMPORARY_MAP_VALUE);
      navigate(
        { pathname: location.pathname, search: `?${next.toString()}` },
        { state: { temporaryMap: true } satisfies TemporaryMapState },
      );
    },
    [navigate, params, location.pathname],
  );

  const close = useCallback(() => {
    if (pushedHere) {
      navigate(-1);
      return;
    }
    // Opened from a link or a reload: there is no entry of ours to pop.
    const next = new URLSearchParams(params);
    next.delete(TEMPORARY_MAP_PARAM);
    const search = next.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: true });
  }, [navigate, params, location.pathname, pushedHere]);

  return { active, open, close };
}
