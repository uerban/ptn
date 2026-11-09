import { useCallback, useId } from "react";
import type { Leg } from "@pt/shared";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import { Icon } from "../Icon.tsx";
import { GuidanceAlerts } from "./GuidanceAlerts.tsx";
import { StepList } from "./StepList.tsx";
import { RiderDashboard } from "./RiderDashboard.tsx";
import { useGuidanceSession } from "./GuidanceSession.tsx";

const NO_LEG_TAP = () => {};

/** Rider mode entered from a stop has no itinerary leg; the dashboard still shows its trip. */
function placeholderLeg(): Leg {
  const now = new Date().toISOString();
  return {
    mode: "BUS",
    from: { name: "", location: { lat: 0, lon: 0 } },
    to: { name: "", location: { lat: 0, lon: 0 } },
    departureTime: now,
    arrivalTime: now,
    durationSeconds: 0,
  };
}

/**
 * Trip guidance without a map: the step list while navigating, the rider
 * dashboard on a vehicle. Progress comes from `GuidanceSessionProvider`, the
 * same as on the map. **Show map** opens the temporary map of the trip.
 */
export function TextGuidance({ onShowMap }: { onShowMap: () => void }) {
  const text = usePresentationText();
  const headingId = useId();
  const phase = useGuidanceStore((s) => s.phase);
  const { currentLeg, upcomingStops, connectingDepartures } = useGuidanceSession();

  const handleStop = useCallback(() => {
    useGuidanceStore.getState().stopNavigation();
  }, []);
  const handleExitRider = useCallback(() => {
    useGuidanceStore.getState().exitRiderMode();
  }, []);

  return (
    <section
      aria-labelledby={headingId}
      data-testid="text-guidance"
      className="relative flex flex-col h-full bg-surface overflow-hidden"
    >
      <header className="flex items-center justify-between gap-2 px-4 pt-4 pb-3 border-b border-divider bg-surface-raised">
        <h1 id={headingId} className="text-base font-semibold text-fg">
          {text("presentation.guidanceHeading")}
        </h1>
        <button
          type="button"
          onClick={onShowMap}
          data-testid="guidance-show-map-btn"
          data-return-focus="guidance-show-map"
          className="flex items-center gap-1 min-h-11 px-3 rounded-lg border border-divider text-sm text-fg hover:bg-surface-overlay"
        >
          <Icon name="map" size={18} className="text-fg-secondary" />
          <span>{text("presentation.showMap")}</span>
        </button>
      </header>
      <div className="flex-1 min-h-0 flex flex-col justify-end">
        {phase === "navigating" && (
          <>
            <GuidanceAlerts />
            <StepList onLegTap={NO_LEG_TAP} onClose={handleStop} />
          </>
        )}
        {phase === "riderMode" && (
          <RiderDashboard
            leg={currentLeg ?? placeholderLeg()}
            upcomingStops={upcomingStops}
            connectingDepartures={connectingDepartures}
            onExit={handleExitRider}
          />
        )}
      </div>
    </section>
  );
}
