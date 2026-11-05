import { create } from "zustand";
import type { BaseEndpoint } from "@pt/shared";
import { persistMapTap } from "../services/coordPrivacy.ts";
import { getPolicy } from "./privacyStore.ts";

interface RawTap {
  readonly lat: number;
  readonly lon: number;
}

interface MapTapState {
  /**
   * In-memory only. Raw sub-meter coords MUST NOT be persisted to disk,
   * URLs, or telemetry. Reduce to a `StoredMapPoint` via `confirmAsEndpoint`
   * before any cross-boundary handoff.
   */
  rawTap: RawTap | null;
  emitTap: (lat: number, lon: number) => void;
  clear: () => void;
  /**
   * Reduces the in-memory raw tap through the active privacy policy and
   * returns a `mappoint` `BaseEndpoint`. Clears the raw tap as a side effect
   * — once consumed, the raw coord is gone.
   */
  confirmAsEndpoint: () => BaseEndpoint | null;
  /**
   * Same reduction as `confirmAsEndpoint` but leaves the raw tap in place.
   * For flows that can still fail after the endpoint is built (the save-with-
   * label write): the pin — and the sheet rendered from it — must survive
   * until the write resolves, then be cleared explicitly. Both paths share
   * one `persistMapTap` call site so the precision seam can't drift.
   */
  reduceToEndpoint: () => BaseEndpoint | null;
}

export const useMapTapStore = create<MapTapState>()((set, get) => ({
  rawTap: null,
  emitTap: (lat, lon) => set({ rawTap: { lat, lon } }),
  clear: () => set({ rawTap: null }),
  reduceToEndpoint: () => {
    const raw = get().rawTap;
    if (!raw) return null;
    const stored = persistMapTap(raw, getPolicy().mapTapPersistedPrecision);
    return { kind: "mappoint", lat: stored.lat, lon: stored.lon };
  },
  confirmAsEndpoint: () => {
    const endpoint = get().reduceToEndpoint();
    if (!endpoint) return null;
    set({ rawTap: null });
    return endpoint;
  },
}));
