import { useState, useCallback, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useCityDataQuery } from "../hooks/useCityDataQuery.ts";
import type { StopGroupRecord } from "../db/index.ts";
import type { Stop } from "@pt/shared";
import { useGeolocation } from "../hooks/useGeolocation.ts";
import { useLineClick } from "../hooks/useLineClick.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useCityGtfsLifecycle } from "../hooks/useCityGtfsLifecycle.ts";
import { FavoritesBar } from "../components/Favorites/FavoritesBar.tsx";
import { DepartureSheet } from "../components/DepartureSheet/DepartureSheet.tsx";
import { NearbyStopsList } from "../components/Schedule/NearbyStopsList.tsx";
import { useTranslation } from "../i18n/index.ts";
import type { FavoritePlace } from "@pt/shared";
import { Icon } from "../components/Icon.tsx";
import { usePresentationText } from "../i18n/presentationStrings.ts";

export interface ScheduleHomeProps {
  /** Show map: opens the temporary map without changing the starting view. */
  onShowMap: () => void;
  /** Nearby departures above the stop list; receives the departure-sheet opener. */
  renderNearbyDepartures?: (showStop: (stop: Stop) => void) => ReactNode;
  /**
   * The stop whose departure sheet is open. Pass it with `onSelectStop` to
   * keep the selection outside this screen; without them it is kept here.
   */
  selectedStop?: Stop | null;
  onSelectStop?: (stop: Stop | null) => void;
}

export function ScheduleHome({
  onShowMap,
  renderNearbyDepartures,
  selectedStop: controlledStop,
  onSelectStop,
}: ScheduleHomeProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const text = usePresentationText();
  const activeCity = useCityStore((s) => s.activeCity);
  const cityId = activeCity.id;

  // Geolocation
  const { location: userLocation, loading: locating } = useGeolocation();

  // Ensure GTFS data is synced for this city. Shares HomePage's reset-on-
  // switch vs defer-on-initial-load policy via useCityGtfsLifecycle; the
  // nearby-stops list is fed reactively by `db.stopGroups` (useLiveQuery),
  // so it fills in once the deferred sync lands.
  useCityGtfsLifecycle(cityId);

  // Load stop groups from IndexedDB (schedule mode uses IndexedDB, not API preloader)
  const stopGroups = useCityDataQuery(data => data.stopGroups.toArray(), []) ?? [];

  // Selected stop for departure sheet
  const [localStop, setLocalStop] = useState<Stop | null>(null);
  const controlled = onSelectStop !== undefined;
  const selectedStop = controlled ? (controlledStop ?? null) : localStop;
  const setSelectedStop = controlled ? onSelectStop : setLocalStop;
  // Line view integration (used by DepartureSheet internally)
  const { cancel: cancelLineLoad } = useLineClick();

  const handleStopSelect = useCallback((group: StopGroupRecord) => {
    cancelLineLoad();
    const firstStopId = group.stopIds[0];
    if (!firstStopId) return;
    // Build a Stop from the StopGroupRecord for DepartureSheet
    const stop: Stop = {
      id: firstStopId,
      name: group.name,
      location: { lat: group.lat, lon: group.lon },
    };
    setSelectedStop(stop);
  }, [cancelLineLoad, setSelectedStop]);

  const handleSheetClose = useCallback(() => {
    cancelLineLoad();
    setSelectedStop(null);
  }, [cancelLineLoad, setSelectedStop]);

  const handleFavoriteClick = useCallback(
    (fav: FavoritePlace) => {
      if (fav.stopId) {
        const stop: Stop = {
          id: fav.stopId,
          name: fav.name,
          location: fav.location,
        };
        setSelectedStop(stop);
      } else {
        navigate(
          `/search?toLat=${fav.location.lat}&toLon=${fav.location.lon}&toName=${encodeURIComponent(fav.name)}`,
        );
      }
    },
    [navigate, setSelectedStop],
  );

  return (
    <section aria-label={text("presentation.textMode")} className="flex flex-col h-full bg-surface overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-divider bg-surface-raised">
        <span className="text-base font-semibold text-fg" data-testid="city-name">
          {activeCity.name}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onShowMap}
            data-return-focus="show-map"
            className="p-2 rounded-lg border border-divider hover:bg-surface-overlay"
            aria-label={t("schedule.show_map", "Show map")}
            title={t("schedule.show_map", "Show map")}
            data-testid="show-map-btn"
          >
            <Icon name="map" className="text-fg-secondary" />
          </button>
        </div>
      </header>


      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Favorites */}
        <nav aria-label={t("schedule.favorites", "Favorites")}>
          <FavoritesBar onFavoriteClick={handleFavoriteClick} />
        </nav>

        {renderNearbyDepartures?.(setSelectedStop)}

        {/* Nearby stops */}
        <section aria-label={t("schedule.nearby", "Nearby stops")}>
          <NearbyStopsList
            groups={stopGroups}
            userLocation={userLocation}
            onStopSelect={handleStopSelect}
            loading={locating}
          />
        </section>
      </div>

      {/* Departure sheet overlay */}
      {selectedStop && (
        <div className="absolute bottom-0 left-0 right-0 z-30 max-h-[60vh]">
          <DepartureSheet
            key={selectedStop.id}
            stop={selectedStop}
            onClose={handleSheetClose}
          />
        </div>
      )}
    </section>
  );
}
