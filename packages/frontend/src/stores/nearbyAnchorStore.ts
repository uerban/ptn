import { create } from "zustand";
import type { LatLon } from "@pt/shared";
import { useCityStore } from "./cityStore.ts";

/**
 * A stop the user chose by hand as the centre of "nearby" when their
 * location is unavailable or declined. In memory only: it is never written
 * to storage, and it belongs to the city it was chosen in.
 */
export interface NearbyAnchor {
  cityId: string;
  stopId: string;
  name: string;
  location: LatLon;
}

interface NearbyAnchorState {
  anchor: NearbyAnchor | null;
  setAnchor: (anchor: NearbyAnchor) => void;
  clear: () => void;
}

export const useNearbyAnchorStore = create<NearbyAnchorState>()((set) => ({
  anchor: null,
  setAnchor: (anchor) => set({ anchor }),
  clear: () => set({ anchor: null }),
}));

/** The chosen anchor for the active city, else null. */
export function useNearbyAnchor(): NearbyAnchor | null {
  const cityId = useCityStore((s) => s.activeCity.id);
  const anchor = useNearbyAnchorStore((s) => s.anchor);
  return anchor && anchor.cityId === cityId ? anchor : null;
}
