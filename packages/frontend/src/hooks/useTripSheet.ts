import { useCallback, useEffect, useRef, useState } from "react";
import type { Departure, StopWithLines } from "@pt/shared";
import { useBikeShareStore } from "../stores/bikeShareStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useGuidanceStore } from "../stores/guidanceStore.ts";
import { useLineViewStore } from "../stores/lineViewStore.ts";
import { useMapTapStore } from "../stores/mapTapStore.ts";

/** An ETA pill's departure, boarded at the pill's stop: what the trip sheet shows. */
export interface TripTarget {
  departure: Departure;
  stop: StopWithLines;
}

export interface UseTripSheetArgs {
  /**
   * The page's line loader (`useLineClick().openLine`, shared with the stop
   * popup so one cancels the other); resolves to whether it showed the line.
   * Given the departure's trip, it opens that trip's direction.
   */
  openLine: (
    routeId: string,
    routeShortName: string,
    routeColor: string | undefined,
    headsign: string,
    tripId?: string,
  ) => Promise<boolean>;
  /** Cancels a pending `openLine` load. */
  cancelLineLoad: () => void;
  /** "All departures here": open this stop's departure sheet. */
  showDepartures: (stop: StopWithLines) => void;
}

export interface TripSheetState {
  /** The open trip, or null. */
  target: TripTarget | null;
  /** A pill was tapped: open its trip. The caller clears its own surfaces (popup, departure sheet). */
  open: (departure: Departure, stop: StopWithLines) => void;
  /**
   * Another surface of the caller's takes the bottom slot: close (cancelling
   * a pending "Show on map"), leaving focus alone.
   */
  dismiss: () => void;
  /** The sheet's own props. */
  onClose: () => void;
  onAllDepartures: () => void;
  onShowOnMap: () => void;
}

/**
 * The trip sheet opened from an ETA pill: its target, its closing rules, its
 * keyboard focus return and its two actions.
 *
 * It shares the bottom slot, so it closes whenever another surface takes it:
 * the line view showing (or switching route), guidance starting, a map
 * long-press pin, a bike-station selection, and a city change are handled
 * here; the caller's own surfaces (stop popup, departure sheet) call
 * `dismiss`. Every closing path but the line view's also cancels a pending
 * "Show on map", which would otherwise land over the surface that took over.
 *
 * Keyboard focus: the strip hides as the sheet opens, so the tapped pill is
 * gone before the sheet could note it as the element to return to. The pill's
 * `data-pill-key` is kept instead, and when the rider closes the sheet (its
 * button or Escape) that pill is focused again once the strip is back. Other
 * closing paths do not pull focus.
 */
export function useTripSheet({ openLine, cancelLineLoad, showDepartures }: UseTripSheetArgs): TripSheetState {
  const [target, setTarget] = useState<TripTarget | null>(null);

  // The id of the "Show on map" load still pending, or 0. The sheet stays up
  // while it loads, so whatever closes the sheet in the meantime has taken
  // the bottom slot, and the load landing later would show the line over it
  // (under guidance, over a long-press pin, or the old city's line after a
  // city change). Only this hook's own load is cancelled: the loader is
  // shared with the stop popup. An id per request, not the trip: a second
  // tap for the same trip supersedes the first load, which then settles
  // while the second is still pending.
  const pendingShowRef = useRef(0);
  const showIdRef = useRef(0);
  const yieldSlot = useCallback(() => {
    if (pendingShowRef.current !== 0) {
      pendingShowRef.current = 0;
      cancelLineLoad();
    }
    setTarget(null);
  }, [cancelLineLoad]);

  // The line view showing is the one closing path that cancels nothing: it is
  // how a "Show on map" ends.
  const lineViewVisible = useLineViewStore((s) => s.isVisible);
  const lineViewRouteId = useLineViewStore((s) => s.activeRouteId);
  useEffect(() => {
    if (lineViewVisible) setTarget(null);
  }, [lineViewVisible, lineViewRouteId]);

  const isNavigating = useGuidanceStore((s) => s.phase) !== "idle";
  useEffect(() => {
    if (isNavigating) yieldSlot();
  }, [isNavigating, yieldSlot]);

  const rawTap = useMapTapStore((s) => s.rawTap);
  useEffect(() => {
    if (rawTap !== null) yieldSlot();
  }, [rawTap, yieldSlot]);

  const selectedBikeStationId = useBikeShareStore((s) => s.selectedStationId);
  useEffect(() => {
    if (selectedBikeStationId !== null) yieldSlot();
  }, [selectedBikeStationId, yieldSlot]);

  // Only when the city actually changes: not on mount.
  const cityId = useCityStore((s) => s.activeCity.id);
  const prevCityRef = useRef(cityId);
  useEffect(() => {
    if (prevCityRef.current === cityId) return;
    prevCityRef.current = cityId;
    yieldSlot();
  }, [cityId, yieldSlot]);

  const pillKeyRef = useRef<string | null>(null);
  const restoreFocusRef = useRef(false);

  // A "Show on map" load still pending from an earlier trip must not land
  // now: its line view would close this sheet. A pill tap also clears a
  // long-press pin (the bike-selection handoff): the long-press sheet leaves
  // the strip up, and the two would otherwise stack in the bottom slot.
  const open = useCallback((departure: Departure, stop: StopWithLines) => {
    const focused = document.activeElement;
    pillKeyRef.current = focused instanceof HTMLElement ? focused.dataset.pillKey ?? null : null;
    restoreFocusRef.current = false;
    cancelLineLoad();
    useMapTapStore.getState().clear();
    setTarget({ departure, stop });
  }, [cancelLineLoad]);

  const dismiss = yieldSlot;

  const onClose = useCallback(() => {
    cancelLineLoad();
    restoreFocusRef.current = pillKeyRef.current !== null;
    setTarget(null);
  }, [cancelLineLoad]);

  useEffect(() => {
    if (target || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const key = pillKeyRef.current;
    pillKeyRef.current = null;
    for (const pill of document.querySelectorAll<HTMLElement>("[data-pill-key]")) {
      if (pill.dataset.pillKey === key) {
        pill.focus();
        return;
      }
    }
  }, [target]);

  // "All departures here": the boarding stop's departure sheet replaces the trip.
  const onAllDepartures = useCallback(() => {
    if (!target) return;
    cancelLineLoad();
    showDepartures(target.stop);
    setTarget(null);
  }, [target, cancelLineLoad, showDepartures]);

  // "Show on map": the line in the direction of the pill's own trip (its
  // headsign alone may name both directions). The sheet closes once the
  // line shows, so a line that fails to load leaves it open. The line-view
  // effect cannot be relied on for this: re-showing the line already on
  // screen changes neither of its deps. Only this target closes — the rider
  // may have opened another trip while the line loaded.
  const onShowOnMap = useCallback(() => {
    if (!target) return;
    const shown = target;
    const { routeId, routeShortName, routeColor, headsign, tripId } = shown.departure;
    const id = ++showIdRef.current;
    pendingShowRef.current = id;
    void openLine(routeId, routeShortName, routeColor, headsign, tripId).then((ok) => {
      if (pendingShowRef.current === id) pendingShowRef.current = 0;
      if (ok) setTarget((current) => (current === shown ? null : current));
    });
  }, [target, openLine]);

  return { target, open, dismiss, onClose, onAllDepartures, onShowOnMap };
}
