import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";
import { liveLocation } from "../../services/liveLocation.ts";
import { useWatchPosition } from "../../hooks/useWatchPosition.ts";
import { useGuidanceLegProgress } from "../../hooks/useGuidanceLegProgress.ts";
import { useRiderModeDetection } from "../../hooks/useRiderModeDetection.ts";
import { useTripNotifications } from "../../hooks/useTripNotifications.ts";
import { useGuidanceDashboard, type GuidanceDashboard } from "../../hooks/useGuidanceDashboard.ts";
import { ServiceAlertTripAnnouncer } from "../ServiceAlerts/ServiceAlertTripAnnouncer.tsx";

const IDLE: GuidanceDashboard = {
  currentLeg: null,
  upcomingStops: [],
  connectingDepartures: [],
};

const GuidanceSessionContext = createContext<GuidanceDashboard>(IDLE);

/**
 * Runs trip guidance once for the home screen, whichever surface shows it:
 * leg progress, rider-mode detection and trip notifications follow the
 * shared foreground position, and the rider dashboard's data is computed
 * here for Text and Map guidance alike. Nothing in it touches the map.
 */
export function GuidanceSessionProvider({ children }: { children: ReactNode }) {
  const watchPos = useWatchPosition(true);
  const isNavigating = useGuidanceStore((s) => s.phase !== "idle");
  useEffect(() => {
    if (isNavigating) liveLocation.request("navigation");
  }, [isNavigating]);

  useGuidanceLegProgress(watchPos.position, watchPos.speed);
  useRiderModeDetection(watchPos.position, watchPos.speed);
  // Background trip notifications (no UI — side-effects only)
  useTripNotifications();

  const dashboard = useGuidanceDashboard();
  return (
    <GuidanceSessionContext.Provider value={dashboard}>
      {children}
      {isNavigating && <ServiceAlertTripAnnouncer />}
    </GuidanceSessionContext.Provider>
  );
}

/** The rider dashboard's data; idle outside `GuidanceSessionProvider`. */
export function useGuidanceSession(): GuidanceDashboard {
  return useContext(GuidanceSessionContext);
}
