import { useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { Stop } from "@pt/shared";
import { ScheduleHome } from "./ScheduleHome.tsx";
import { TextGuidance } from "../components/Guidance/TextGuidance.tsx";
import { NearbyDeparturesList } from "../components/Schedule/NearbyDeparturesList.tsx";
import { useGuidanceStore } from "../stores/guidanceStore.ts";
import { useLineViewStore } from "../stores/lineViewStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useNearbyAnchor } from "../stores/nearbyAnchorStore.ts";
import { useWatchPosition } from "../hooks/useWatchPosition.ts";
import { restoreReturnFocus, type TemporaryMap } from "../presentation/temporaryMap.ts";
import { useShowMapAction } from "../presentation/ShowMapAction.tsx";
import { WhatsNewCard } from "../components/WhatsNew/WhatsNewCard.tsx";

/**
 * A line opened from a departure list is shown on its own page here: the
 * map's line overlay is not part of Text mode.
 */
function useLinePageForLineView() {
  const navigate = useNavigate();
  useEffect(
    () =>
      useLineViewStore.subscribe((state, previous) => {
        if (!state.isVisible || !state.activeRouteId) return;
        if (previous.isVisible && previous.activeRouteId === state.activeRouteId) return;
        const { activeRouteId, activeDirection } = state;
        useLineViewStore.getState().hideLine();
        navigate(`/line/${encodeURIComponent(activeRouteId)}?dir=${activeDirection}`);
      }),
    [navigate],
  );
}

function NearbyDepartures({ showStop }: { showStop: (stop: Stop) => void }) {
  const enabled = useSettingsStore((s) => s.etaCardsEnabled);
  const position = useWatchPosition(true).position;
  const anchor = useNearbyAnchor();
  if (!enabled) return null;
  return (
    <NearbyDeparturesList
      center={position ?? anchor?.location ?? null}
      chosenStopName={position ? null : anchor?.name ?? null}
      onSelectStop={showStop}
    />
  );
}

/**
 * The Text mode home screen: departures, stops, favorites and search, and
 * trip guidance once a trip starts, with no map module loaded. **Show map**
 * opens a temporary map (`temporaryMap`); coming back restores focus.
 */
export interface TextHomeProps {
  temporaryMap: TemporaryMap;
  /** The stop whose departures are shown; kept by the caller so it survives
   * a trip to the temporary map. */
  selectedStop?: Stop | null;
  onSelectStop?: (stop: Stop | null) => void;
}

export function TextHome({ temporaryMap, selectedStop, onSelectStop }: TextHomeProps) {
  const phase = useGuidanceStore((s) => s.phase);
  const showMap = useShowMapAction(temporaryMap);
  const { request } = showMap;
  useLinePageForLineView();

  useEffect(() => {
    restoreReturnFocus();
  }, []);

  const showStopsMap = useCallback(() => request("show-map"), [request]);
  const showTripMap = useCallback(() => request("guidance-show-map"), [request]);
  const renderNearby = useCallback(
    (showStop: (stop: Stop) => void) => (
      <>
        <WhatsNewCard placement="inline" />
        <NearbyDepartures showStop={showStop} />
      </>
    ),
    [],
  );

  return (
    <>
      {phase === "idle" ? (
        <ScheduleHome
          onShowMap={showStopsMap}
          renderNearbyDepartures={renderNearby}
          selectedStop={selectedStop}
          onSelectStop={onSelectStop}
        />
      ) : (
        <TextGuidance onShowMap={showTripMap} />
      )}
      {showMap.disclosure}
    </>
  );
}
