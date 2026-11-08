import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type * as maplibregl from "maplibre-gl";
import { TransitMap } from "../components/Map/TransitMap.tsx";
import { FavoritesBar } from "../components/Favorites/FavoritesBar.tsx";
import { Icon } from "../components/Icon.tsx";
import { StopPopup } from "../components/Map/StopPopup.tsx";
import { MapTapActionSheet } from "../components/Map/MapTapActionSheet.tsx";
import { LineRouteOverlay } from "../components/Map/LineRouteOverlay.tsx";
import { DepartureSheet } from "../components/DepartureSheet/DepartureSheet.tsx";
import { TripSheet } from "../components/TripSheet/TripSheet.tsx";
import { useStopStore } from "../stores/stopStore.ts";
import { useStopPreloader } from "../hooks/useStopPreloader.ts";
import { useOsrmPrewarm } from "../hooks/useOsrmPrewarm.ts";
import { useVisibleStops } from "../hooks/useVisibleStops.ts";
import { useViewportBadgeActivity } from "../hooks/useViewportBadgeActivity.ts";
import { useDepartures } from "../hooks/useDepartures.ts";
import { useNearbyDirections } from "../hooks/useNearbyDirections.ts";
import { useTranslation } from "../i18n/index.ts";
import { ModeToggle } from "../components/Map/ModeToggle.tsx";
import { BikeShareToggle } from "../components/Map/BikeShareToggle.tsx";
import { BikeShareLayer } from "../components/Map/BikeShareLayer.tsx";
import { GtfsCorridorLayer } from "../components/Map/GtfsCorridorLayer.tsx";
import { MicromapLayer } from "../components/Map/MicromapLayer.tsx";
import { MapDetailControl } from "../components/Map/MapDetailControl.tsx";
import { BikeShareStationSheet } from "../components/Map/BikeShareStationSheet.tsx";
import { useBikeShareStore } from "../stores/bikeShareStore.ts";
import { useMapTapStore } from "../stores/mapTapStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useGuidanceStore } from "../stores/guidanceStore.ts";
import { useLineViewStore } from "../stores/lineViewStore.ts";
import { useLineClick } from "../hooks/useLineClick.ts";
import { useTripSheet } from "../hooks/useTripSheet.ts";
import { StepList } from "../components/Guidance/StepList.tsx";
import { RiderDashboard } from "../components/Guidance/RiderDashboard.tsx";
import { RiderModePrompt } from "../components/Guidance/RiderModePrompt.tsx";
import { RouteOverlay } from "../components/Map/RouteOverlay.tsx";
import { UserPositionMarker } from "../components/Map/UserPositionMarker.tsx";
import { TransferBadge } from "../components/Map/TransferBadge.tsx";
import { useWatchPosition } from "../hooks/useWatchPosition.ts";
import { useDeviceHeading } from "../hooks/useDeviceHeading.ts";
import { useMapGuidance } from "../hooks/useMapGuidance.ts";
import { findStopContextCandidates } from "../hooks/useRiderModeDetection.ts";
import { useGuidanceSession } from "../components/Guidance/GuidanceSession.tsx";
import { TextModeButton } from "../presentation/TextModeButton.tsx";
import { GuidanceAlerts } from "../components/Guidance/GuidanceAlerts.tsx";
import { ETACards, type EtaStopInfo } from "../components/Map/ETACards.tsx";
import { MapObstacle } from "../components/Map/MapObstacle.tsx";
import { haversineDistance } from "../utils/geo.ts";
import { useCityGtfsLifecycle } from "../hooks/useCityGtfsLifecycle.ts";
import type { StopWithLines, FavoritePlace, RiderCandidate, Departure } from "@pt/shared";
import {
  GTFS_CLIENT_REFRESH_INTERVAL_MS,
  PEDESTRIAN_SPEED_THRESHOLD_MS,
} from "@pt/shared/constants";

// ---------------------------------------------------------------------------
// Popup and sheet are independent — you can browse popups for different stops
// while the sheet stays open showing another stop's full timetable.
// ---------------------------------------------------------------------------

export interface HomePageProps {
  /** Set when the map is a temporary view opened from Text mode. */
  onBackToText?: () => void;
}

export function HomePage({ onBackToText }: HomePageProps = {}) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  // The same foreground position feeds the map, nearby stops, and guidance.
  const watchPos = useWatchPosition(true);
  const geoPosition = watchPos.position;

  // --- Store & preloader ---------------------------------------------------
  // `stops` is the filtered set to render. The full cached set lives in
  // `useStopStore`; `useVisibleStops` derives the urban-mode view from it
  // against the local timetable, so toggling urban mode never drops
  // anything from the store and the filter updates on the minute.
  const stops = useVisibleStops();
  // Populate badgeActivityStore from the viewport's schedule tiles so urban-mode
  // card badges are sourced from the complete tile data (read by useVisibleStops).
  useViewportBadgeActivity();
  // Schedule nearby results stay entirely local, even with foreground GPS.
  useStopPreloader(geoPosition, watchPos.requestId);
  const activeCity = useCityStore((s) => s.activeCity);

  // Map instance is state, not ref, so overlays re-render when the map's
  // `load` event fires. With a ref, RouteOverlay could be evaluated against
  // a not-yet-style-loaded map and throw on addSource/addLayer.
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null);
  const handleMapReady = useCallback((m: maplibregl.Map) => {
    setMapInstance(m);
  }, []);

  // --- Guidance state ---
  const guidancePhase = useGuidanceStore((s) => s.phase);
  const guidanceItinerary = useGuidanceStore((s) => s.itinerary);
  const legStatuses = useGuidanceStore((s) => s.legStatuses);
  const currentLegIndex = useGuidanceStore((s) => s.currentLegIndex);
  const isNavigating = guidancePhase !== "idle";

  const { heading } = useDeviceHeading(isNavigating);

  // Map guidance (zoom-to-leg, auto-follow, rider bearing)
  const { zoomToLeg } = useMapGuidance(
    mapInstance,
    guidanceItinerary,
    watchPos.position,
    watchPos.heading // vehicle heading from geolocation for rider mode bearing
  );

  const handleGuidanceLegTap = useCallback(
    (legIndex: number) => {
      zoomToLeg(legIndex);
    },
    [zoomToLeg]
  );

  const handleStopNavigation = useCallback(() => {
    useGuidanceStore.getState().stopNavigation();
  }, []);

  const handleExitRiderMode = useCallback(() => {
    useGuidanceStore.getState().exitRiderMode();
  }, []);

  // --- Rider dashboard data (progress tracking runs in GuidanceSessionProvider) ---
  const { currentLeg, upcomingStops, connectingDepartures } = useGuidanceSession();

  // --- Stop-context rider mode prompt ---
  const [stopContextCandidates, setStopContextCandidates] = useState<RiderCandidate[]>([]);
  const lastViewedDeparturesRef = useRef<Departure[]>([]);

  // Monitor speed to trigger the rider mode prompt when a user boards a vehicle
  useEffect(() => {
    // Only detect when not already navigating or in rider mode
    if (guidancePhase !== "idle") {
      setStopContextCandidates([]);
      return;
    }

    const speed = watchPos.speed;
    if (speed === null || speed < PEDESTRIAN_SPEED_THRESHOLD_MS) return;

    const recentDepartures = lastViewedDeparturesRef.current;
    if (recentDepartures.length > 0) {
      const candidates = findStopContextCandidates(recentDepartures, new Date());
      if (candidates.length > 0 && candidates.length <= 3) {
        setStopContextCandidates(candidates);
      }
    }
  }, [watchPos.speed, guidancePhase]);

  const handleRiderModeSelect = useCallback((candidate: RiderCandidate) => {
    useGuidanceStore.getState().enterRiderMode("stopContext", candidate.tripId);
    setStopContextCandidates([]);
  }, []);

  const handleRiderModeDismiss = useCallback(() => {
    setStopContextCandidates([]);
  }, []);

  // --- Line view coordination -----------------------------------------------
  const lineViewVisible = useLineViewStore((s) => s.isVisible);
  const lineViewRouteId = useLineViewStore((s) => s.activeRouteId);

  // --- Independent popup and sheet state -----------------------------------
  const [popupStop, setPopupStop] = useState<StopWithLines | null>(null);
  const [sheetStop, setSheetStop] = useState<StopWithLines | null>(null);

  // Dismiss popup and sheet when line view becomes visible or switches route
  useEffect(() => {
    if (lineViewVisible) {
      setPopupStop(null);
      setSheetStop(null);
    }
  }, [lineViewVisible, lineViewRouteId]);

  // Departure fetch for popup (no polling — one-shot, 1.5h window keeps list manageable)
  const { departures: popupDepartures, loading: popupLoading } =
    useDepartures(popupStop?.id ?? null, false, 1.5, { hedge: true });

  // Track last-viewed departures from popup for stop-context rider mode
  useEffect(() => {
    if (popupDepartures.length > 0) {
      lastViewedDeparturesRef.current = popupDepartures;
    }
  }, [popupDepartures]);

  // --- Handlers ------------------------------------------------------------
  // One line loader for the stop popup and the trip sheet: opening either
  // cancels the other's pending load.
  const { openLine, cancel: cancelLineLoad } = useLineClick();

  // Trip sheet: an ETA pill's departure, boarded at the pill's stop. It shares
  // the bottom slot, so it never stays up with the popup or departure sheet;
  // the hook closes it for every other surface.
  const trip = useTripSheet({ openLine, cancelLineLoad, showDepartures: setSheetStop });
  const { target: tripTarget, dismiss: dismissTrip, open: openTrip } = trip;

  // On unmount (e.g. navigating to /search), clear line view state
  // so it doesn't persist across page transitions.
  useEffect(() => () => {
    useLineViewStore.getState().hideLine();
  }, []);

  const handleStopClick = useCallback((stop: StopWithLines) => {
    if (useLineViewStore.getState().isVisible) return;
    cancelLineLoad();
    useStopStore.getState().recordTap(stop.id);
    // A stop tap never reaches the bike circle-layer handler (the stop
    // layers win shared taps), so an open bike-station sheet must be
    // closed here — the stop popup replaces it.
    useBikeShareStore.getState().clearStationSelection();
    dismissTrip();
    setPopupStop(stop);
  }, [cancelLineLoad, dismissTrip]);

  const handleSeeAll = useCallback(() => {
    if (popupStop) {
      cancelLineLoad();
      setSheetStop(popupStop);
      setPopupStop(null);
    }
  }, [popupStop, cancelLineLoad]);

  const handlePopupClose = useCallback(() => {
    cancelLineLoad();
    setPopupStop(null);
  }, [cancelLineLoad]);

  const handleSheetClose = useCallback(() => {
    setSheetStop(null);
  }, []);

  const handleMapClick = useCallback(() => {
    cancelLineLoad();
    setPopupStop(null);
    // Empty-map tap also closes the bike-station sheet. Ordering note: the
    // generic map click fires BEFORE the bike circle-layer handler (it was
    // registered first), so a tap ON a bike marker clears here and then
    // re-selects in BikeShareLayer — the sheet still opens.
    useBikeShareStore.getState().clearStationSelection();
  }, [cancelLineLoad]);

  const handleFavoriteClick = useCallback(
    (fav: FavoritePlace) => {
      if (fav.stopId && useLineViewStore.getState().isVisible) return;
      if (fav.stopId) {
        const stopFromStore = stops.find((s) => s.id === fav.stopId);
        const stop: StopWithLines = stopFromStore ?? {
          id: fav.stopId,
          name: fav.name,
          location: fav.location,
          lastSeen: Date.now(),
        };
        cancelLineLoad();
        useStopStore.getState().recordTap(stop.id);
        useBikeShareStore.getState().clearStationSelection();
        dismissTrip();
        setPopupStop(stop);
      } else {
        navigate(
          `/search?toLat=${fav.location.lat}&toLon=${fav.location.lon}&toName=${encodeURIComponent(fav.name)}`
        );
      }
    },
    [navigate, stops, cancelLineLoad, dismissTrip]
  );

  // Clear popup, sheet, and cached stops when city *actually changes*
  // so stale stop data doesn't fetch departures from the wrong backend.
  // Skip the initial mount so hydration can reuse the owned API snapshot.
  // Reset only invalidates memory and pending writes; it does not clear disk.
  const prevCityRef = useRef(activeCity.id);
  useEffect(() => {
    if (prevCityRef.current === activeCity.id) return;
    prevCityRef.current = activeCity.id;
    setPopupStop(null);
    setSheetStop(null);
    useLineViewStore.getState().hideLine();
    useStopStore.getState().reset();
    // Bike layer is session-only opt-in per city: switching city turns it
    // off so no further operator requests fire for the old city; the chip
    // for the new city (if configured) starts OFF again.
    useBikeShareStore.getState().disable();
  }, [activeCity.id]);

  // The long-press MapTapActionSheet and the BikeShareStationSheet render
  // in the same bottom slot — when a long-press drops a pin, the bike sheet
  // yields so the two never stack. (The trip sheet yields too: useTripSheet.)
  const rawTap = useMapTapStore((s) => s.rawTap);
  useEffect(() => {
    if (rawTap !== null) {
      useBikeShareStore.getState().clearStationSelection();
    }
  }, [rawTap]);

  // The handoff is bidirectional: selecting a bike station also closes every
  // competing bottom surface. Keeping this coordination in Home avoids
  // coupling the bike store to map-tap or transit-popup implementation state.
  // (The trip sheet closes itself: useTripSheet.)
  const selectedBikeStationId = useBikeShareStore((s) => s.selectedStationId);
  useEffect(() => {
    if (selectedBikeStationId === null) return;
    cancelLineLoad();
    setPopupStop(null);
    setSheetStop(null);
    useMapTapStore.getState().clear();
  }, [selectedBikeStationId, cancelLineLoad]);

  // GTFS data lifecycle (reset-on-switch vs defer-on-initial-load).
  const cityId = useCityStore((s) => s.activeCity.id);
  useCityGtfsLifecycle(cityId);

  // Closes D-030: prewarm OSRM during idle so first search uses OSRM
  // quality. See useOsrmPrewarm for platform / no-op semantics.
  useOsrmPrewarm(cityId);

  // Periodic GTFS refresh every GTFS_CLIENT_REFRESH_INTERVAL_MS
  useEffect(() => {
    const timer = setInterval(() => {
      useGtfsDataStore.getState().init(cityId);
    }, GTFS_CLIENT_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [cityId]);

  const etaCardsEnabled = useSettingsStore((s) => s.etaCardsEnabled);
  const etaCardsLayout = useSettingsStore((s) => s.etaCardsLayout);
  const startupLocate = useSettingsStore((s) => s.startupLocate);

  // Leaving the map view turns the bike layer off — same session-only
  // privacy stance as the city-switch disable above. Switching to Text mode
  // and navigating away (/search, /settings, a line view) both unmount Home
  // entirely. Either way the map, the bike toggle, and the layer are gone,
  // so without the disable the store's 60 s poll would keep hitting the
  // third-party operator with nothing visible on screen and no off control
  // anywhere. The unmount cleanup also means returning to Home always
  // finds the chip OFF: opt-in is per-visit, never an auto-refetch.
  useEffect(() => () => {
    useBikeShareStore.getState().disable();
  }, []);

  // --- ETA Cards: nearest stop's lines, both directions ---------------------
  // Off while the departure sheet, guidance or a
  // bike station takes the bottom slot: the hook then fetches nothing, not even
  // the nearest stop. The stop popup, the trip sheet and the line view only
  // hide the strip (below), so it reappears without a refetch.
  const etaEnabled =
    etaCardsEnabled &&
    !isNavigating &&
    !sheetStop &&
    selectedBikeStationId === null;
  // ETA cards are unprompted (proximity). The nearest stop is read from its tile (+ rt-tile
  // overlay) and never hedges; only a tile failure falls back to `departures-for-stop` for that one
  // stop, and only where the privacy policy allows it. The other stops are read from tiles only.
  const nearby = useNearbyDirections({ enabled: etaEnabled, position: geoPosition, visibleStops: stops });
  // Null whenever the hook is off.
  const nearestStop = nearby.nearestStop;

  // Every side's stop for the strip, with its distance from the live position.
  // Reverse stops may be off screen: look them up in the full city set.
  const allStops = useStopStore((s) => s.stops);
  const stopsById = useMemo(() => new Map(allStops.map((s) => [s.id, s])), [allStops]);
  const etaStopInfo = useMemo(() => {
    const info = new Map<string, EtaStopInfo>();
    if (!nearestStop || !geoPosition) return info;
    for (const id of [nearestStop.id, ...nearby.sides.map((s) => s.stopId)]) {
      if (info.has(id)) continue;
      const stop = id === nearestStop.id ? nearestStop : stopsById.get(id);
      if (stop) info.set(id, { stop, distanceM: haversineDistance(geoPosition, stop.location) });
    }
    return info;
  }, [nearestStop, nearby.sides, stopsById, geoPosition]);

  // Pill tap → trip sheet, in place of every other bottom surface. (The strip
  // never shows with the popup, the departure sheet or the line view up; they
  // are cleared anyway.)
  const handleEtaSelect = useCallback((departure: Departure, stop: StopWithLines) => {
    setPopupStop(null);
    setSheetStop(null);
    openTrip(departure, stop);
  }, [openTrip]);

  return (
    <div className="relative h-full flex flex-col" data-sheet={sheetStop || tripTarget ? "" : undefined}>
      {/* Floating search bar */}
      <MapObstacle
        id="search-bar"
        className="absolute top-3 left-3 right-3 z-10 flex items-center gap-2"
      >
        <button
          onClick={() => navigate("/search")}
          className="flex-1 min-w-0 flex items-center gap-2 px-4 py-3 bg-surface-raised
            rounded-xl shadow-2
            text-fg-muted text-left"
        >
          <Icon name="search" className="shrink-0" />
          <span className="truncate">{t("search.where_to", "Where are you going?")}</span>
        </button>
        <div className="flex flex-col sm:flex-row items-center gap-1 sm:gap-2 shrink-0">
          <span className="px-2 py-0.5 sm:py-1.5 text-xs text-fg-muted font-medium whitespace-nowrap" data-testid="city-name">
            {activeCity.name}
          </span>
          <ModeToggle />
          <BikeShareToggle />
          <TextModeButton onBackToText={onBackToText} />
        </div>
      </MapObstacle>

      {/* Favorites bar, then the map-detail control and the local map's
          status below it. The column itself lets map gestures through. */}
      <div className="absolute top-[4.5rem] left-0 right-0 z-10 pointer-events-none">
        <MapObstacle id="favorites-bar" className="pointer-events-auto">
          <FavoritesBar onFavoriteClick={handleFavoriteClick} />
        </MapObstacle>
        <MapObstacle id="map-detail" className="pointer-events-auto inline-block ml-3 mt-1">
          <MapDetailControl />
        </MapObstacle>
      </div>

      {/* Map */}
      <div className="flex-1 relative">
        <TransitMap
          stops={stops}
          geometryStops={allStops}
          onStopClick={handleStopClick}
          onMapClick={handleMapClick}
          onMapReady={handleMapReady}
          autoLocateOnLoad={startupLocate}
          selectedStopId={popupStop?.id ?? sheetStop?.id}
        />
        <LineRouteOverlay map={mapInstance} />
        {/* Offline basemap; sits under the corridors, both local-mode only. */}
        <MicromapLayer map={mapInstance} />
        <GtfsCorridorLayer map={mapInstance} />
        {/* Subscribes to bikeShareStore itself; no-op until the chip opts in. */}
        <BikeShareLayer map={mapInstance} />
        <MapTapActionSheet />
        <BikeShareStationSheet />
      </div>

      {/* Gated on mapInstance: overlays must not run addSource/addLayer
          before the map's style has loaded. */}
      {mapInstance && (
        <UserPositionMarker
          map={mapInstance}
          position={watchPos.position}
          heading={isNavigating ? heading ?? watchPos.heading : watchPos.heading}
          accuracy={watchPos.accuracy}
          paused={watchPos.paused}
        />
      )}
      {isNavigating && mapInstance && (
        <>
          <RouteOverlay
            map={mapInstance}
            itinerary={guidanceItinerary}
            legStatuses={legStatuses}
          />
          <TransferBadge
            map={mapInstance}
            itinerary={guidanceItinerary}
            currentLegIndex={currentLegIndex}
          />
        </>
      )}

      {/* Guidance step list (navigating phase) */}
      {guidancePhase === "navigating" && (
        <MapObstacle id="step-list" className="absolute bottom-0 left-0 right-0 z-25">
          <GuidanceAlerts />
          <StepList
            onLegTap={handleGuidanceLegTap}
            onClose={handleStopNavigation}
          />
        </MapObstacle>
      )}

      {/* Rider mode dashboard */}
      {guidancePhase === "riderMode" && (
        <MapObstacle id="rider-dashboard" className="absolute bottom-0 left-0 right-0 z-25">
          <RiderDashboard
            leg={currentLeg ?? {
              mode: "BUS",
              from: { name: "", location: { lat: 0, lon: 0 } },
              to: { name: "", location: { lat: 0, lon: 0 } },
              departureTime: new Date().toISOString(),
              arrivalTime: new Date().toISOString(),
              durationSeconds: 0,
            }}
            upcomingStops={upcomingStops}
            connectingDepartures={connectingDepartures}
            onExit={handleExitRiderMode}
          />
        </MapObstacle>
      )}

      {/* Stop-context rider mode prompt */}
      {stopContextCandidates.length > 0 && (
        <MapObstacle
          id="rider-mode-prompt"
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-30"
        >
          <RiderModePrompt
            candidates={stopContextCandidates}
            onSelect={handleRiderModeSelect}
            onDismiss={handleRiderModeDismiss}
          />
        </MapObstacle>
      )}

      {/* ETA cards — next departures near the user, a row per side of the street.
          Hidden under the line view: a pill would open a trip sheet over it. */}
      {nearestStop && !popupStop && !tripTarget && !lineViewVisible && (
        <ETACards
          sides={nearby.sides}
          departuresBySide={nearby.departuresBySide}
          nearestStop={nearestStop}
          stopInfo={etaStopInfo}
          loading={nearby.loading}
          layout={etaCardsLayout}
          onSelect={handleEtaSelect}
        />
      )}

      {/* Stop popup (tier 1) — bottom-center overlay, above sheet if both visible */}
      {popupStop && (
        <MapObstacle
          id="stop-popup"
          className={`absolute left-1/2 -translate-x-1/2 z-30 ${
            sheetStop ? "bottom-[50%]" : "bottom-4"
          }`}
        >
          <StopPopup
            stopName={popupStop.name}
            departures={popupDepartures}
            loading={popupLoading}
            isSheetOpen={sheetStop?.id === popupStop.id}
            onSeeAll={handleSeeAll}
            onClose={handlePopupClose}
            onLineClick={openLine}
          />
        </MapObstacle>
      )}

      {/* Departure sheet (tier 2) — anchored at bottom, independent of popup */}
      {sheetStop && (
        <MapObstacle id="departure-sheet" className="absolute bottom-0 left-0 right-0 z-20">
          <DepartureSheet key={sheetStop.id} stop={sheetStop} onClose={handleSheetClose} />
        </MapObstacle>
      )}

      {/* Trip sheet — an ETA pill's trip: its stops and the estimated vehicle */}
      {tripTarget && (
        <MapObstacle id="trip-sheet" className="absolute bottom-0 left-0 right-0 z-20">
          <TripSheet
            key={`${tripTarget.stop.id}:${tripTarget.departure.tripId}:${tripTarget.departure.scheduledTime}`}
            departure={tripTarget.departure}
            stop={tripTarget.stop}
            onClose={trip.onClose}
            onAllDepartures={trip.onAllDepartures}
            onShowOnMap={trip.onShowOnMap}
          />
        </MapObstacle>
      )}
    </div>
  );
}
