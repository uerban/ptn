import { create } from "zustand";
import type {
  Itinerary,
  GuidancePhase,
  LegStatus,
  RiderModeActivation,
  WalkingProgress,
  TransitProgress,
} from "@pt/shared";
import { useRtStore } from "./rtStore.ts";

interface GuidanceState {
  phase: GuidancePhase;
  itinerary: Itinerary | null;
  currentLegIndex: number;
  legStatuses: LegStatus[];
  walkingProgress: WalkingProgress | null;
  transitProgress: TransitProgress | null;
  riderModeActivation: RiderModeActivation | null;
  riderTripId: string | null;
  /**
   * The itinerary whose last leg the rider just completed — set only by
   * `advanceLeg` running off the end, never by a manual stop, so "arrived"
   * can be told from "gave up". Cleared by the next start, stop or reset.
   */
  completedItinerary: Itinerary | null;

  startNavigation: (itinerary: Itinerary) => void;
  stopNavigation: () => void;
  advanceLeg: () => void;
  enterRiderMode: (activation: RiderModeActivation, tripId: string) => void;
  exitRiderMode: () => void;
  setWalkingProgress: (progress: WalkingProgress) => void;
  /** null: the rider is not on the vehicle (yet), whatever the leg says. */
  setTransitProgress: (progress: TransitProgress | null) => void;
  setTransferProximity: (isNearTransfer: boolean) => void;
  reset: () => void;
}

function computeLegStatuses(
  legCount: number,
  currentIndex: number
): LegStatus[] {
  return Array.from({ length: legCount }, (_, i) => {
    if (i < currentIndex) return "completed";
    if (i === currentIndex) return "current";
    if (i === currentIndex + 1) return "upcoming";
    return "future";
  });
}

const initialState = {
  phase: "idle" as GuidancePhase,
  itinerary: null as Itinerary | null,
  currentLegIndex: 0,
  legStatuses: [] as LegStatus[],
  walkingProgress: null as WalkingProgress | null,
  transitProgress: null as TransitProgress | null,
  riderModeActivation: null as RiderModeActivation | null,
  riderTripId: null as string | null,
  completedItinerary: null as Itinerary | null,
};

export const useGuidanceStore = create<GuidanceState>()((set, get) => ({
  ...initialState,

  startNavigation: (itinerary: Itinerary) => {
    set({
      phase: "navigating",
      itinerary,
      currentLegIndex: 0,
      legStatuses: computeLegStatuses(itinerary.legs.length, 0),
      walkingProgress: null,
      transitProgress: null,
      riderModeActivation: null,
      riderTripId: null,
    });

    // Subscribe to RT data for every transit route in this itinerary. The
    // endpoint is /rt/<routeId> and answers with every trip on that route;
    // subscribing trip ids asked for routes that don't exist, so guidance
    // never received live data at all.
    const routeIds = [
      ...new Set(
        itinerary.legs.filter((leg) => leg.tripId && leg.routeId).map((leg) => leg.routeId!),
      ),
    ];
    if (routeIds.length > 0) {
      useRtStore.getState().subscribeRoutes(routeIds);
    }
    useRtStore.getState().setMode("navigating");
  },

  stopNavigation: () => {
    useRtStore.getState().setMode("idle");
    useRtStore.getState().unsubscribeAll();
    set({ ...initialState });
  },

  advanceLeg: () => {
    const { itinerary, currentLegIndex } = get();
    if (!itinerary) return;

    const nextIndex = currentLegIndex + 1;
    if (nextIndex >= itinerary.legs.length) {
      // Navigation complete — cleanup RT subscriptions
      useRtStore.getState().unsubscribeAll();
      useRtStore.getState().setMode("idle");
      set({ ...initialState, completedItinerary: itinerary });
      return;
    }

    set({
      currentLegIndex: nextIndex,
      legStatuses: computeLegStatuses(itinerary.legs.length, nextIndex),
      walkingProgress: null,
      transitProgress: null,
    });
  },

  enterRiderMode: (activation: RiderModeActivation, tripId: string) => {
    set({
      phase: "riderMode",
      riderModeActivation: activation,
      riderTripId: tripId,
    });
  },

  exitRiderMode: () => {
    const { itinerary } = get();
    set({
      phase: itinerary ? "navigating" : "idle",
      riderModeActivation: null,
      riderTripId: null,
    });
  },

  setWalkingProgress: (progress: WalkingProgress) => {
    set({ walkingProgress: progress });
  },

  setTransitProgress: (progress: TransitProgress | null) => {
    set({ transitProgress: progress });
  },

  setTransferProximity: (isNearTransfer: boolean) => {
    const rtStore = useRtStore.getState();
    if (isNearTransfer) {
      rtStore.setMode("transfer");
    } else if (get().phase === "navigating") {
      rtStore.setMode("navigating");
    }
  },

  reset: () => {
    useRtStore.getState().setMode("idle");
    useRtStore.getState().unsubscribeAll();
    set({ ...initialState });
  },
}));
