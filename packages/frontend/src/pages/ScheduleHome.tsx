import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useCityDataQuery } from "../hooks/useCityDataQuery.ts";
import type { StopGroupRecord } from "../db/index.ts";
import type { Stop } from "@pt/shared";
import { useGeolocation } from "../hooks/useGeolocation.ts";
import { useLineClick } from "../hooks/useLineClick.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useCityGtfsLifecycle } from "../hooks/useCityGtfsLifecycle.ts";
import { FavoritesBar } from "../components/Favorites/FavoritesBar.tsx";
import { DepartureSheet } from "../components/DepartureSheet/DepartureSheet.tsx";
import { NearbyStopsList } from "../components/Schedule/NearbyStopsList.tsx";
import { useTranslation } from "../i18n/index.ts";
import type { FavoritePlace } from "@pt/shared";
import { Icon } from "../components/Icon.tsx";

const FIRST_LAUNCH_KEY = "ptn-schedule-seen";

export function ScheduleHome() {
  const navigate = useNavigate();
  const { t } = useTranslation();
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

  // First-launch hint
  const [showHint, setShowHint] = useState<boolean>(
    () => !localStorage.getItem(FIRST_LAUNCH_KEY),
  );

  const dismissHint = useCallback(() => {
    localStorage.setItem(FIRST_LAUNCH_KEY, "1");
    setShowHint(false);
  }, []);

  // Selected stop for departure sheet
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
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
  }, [cancelLineLoad]);

  const handleSheetClose = useCallback(() => {
    cancelLineLoad();
    setSelectedStop(null);
  }, [cancelLineLoad]);

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
    [navigate],
  );

  return (
    <main aria-label={t("schedule.main", "Schedule view")} className="flex flex-col h-full bg-surface overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 pt-safe-top pt-4 pb-3 border-b border-divider bg-surface-raised">
        <span className="text-base font-semibold text-fg" data-testid="city-name">
          {activeCity.name}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="plan-trip-btn"
            onClick={() => navigate("/search")}
            className="px-4 py-2 rounded-full bg-primary text-white text-sm font-semibold shadow hover:bg-primary/90 active:scale-95 transition-all"
          >
            {t("schedule.plan_trip", "Plan trip")}
          </button>
          <button
            type="button"
            onClick={() => useSettingsStore.getState().setScheduleMode(false)}
            className="p-2 rounded-lg border border-divider hover:bg-surface-overlay"
            aria-label={t("schedule.show_map", "Show map")}
            title={t("schedule.show_map", "Show map")}
            data-testid="show-map-btn"
          >
            <Icon name="map" className="text-fg-secondary" />
          </button>
        </div>
      </header>

      {/* Search bar */}
      <nav aria-label={t("schedule.search", "Search")} className="px-3 py-2 border-b border-divider">
        <button
          type="button"
          data-testid="search-bar"
          onClick={() => navigate("/search")}
          className="w-full flex items-center gap-2 px-4 py-3 bg-surface-overlay rounded-xl border border-divider text-fg-muted text-left hover:bg-surface-raised transition-colors"
          aria-label={t("search.where_to", "Where to?")}
        >
          <Icon name="search" className="shrink-0" />
          <span className="truncate">{t("search.where_to", "Where to?")}</span>
        </button>
      </nav>

      {/* First-launch hint */}
      {showHint && (
        <div
          data-testid="first-launch-hint"
          className="flex items-center justify-between gap-2 mx-3 mt-2 px-3 py-2 bg-surface-raised border border-divider rounded-lg text-sm text-fg-muted"
          role="note"
        >
          <span>
            {t("schedule.hint", "Looking for a route? Tap 'Plan trip' above.")}
          </span>
          <button
            type="button"
            data-testid="dismiss-hint-btn"
            aria-label={t("schedule.dismiss_hint", "Dismiss hint")}
            onClick={dismissHint}
            className="p-1 rounded hover:bg-surface-overlay shrink-0"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Favorites */}
        <nav aria-label={t("schedule.favorites", "Favorites")}>
          <FavoritesBar onFavoriteClick={handleFavoriteClick} />
        </nav>

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
    </main>
  );
}
