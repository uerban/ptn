import { liveLocation } from "../services/liveLocation.ts";
import { useTripStart } from "../components/Guidance/TripStartExplainer.tsx";
import { excludedRouteIdsForGroups, routeGroupFor, type RouteGroup } from "../services/routeGroups.ts";
import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { RouteResults } from "../components/RouteResults/RouteResults.tsx";
import { RoutingModeIndicator } from "../components/RoutingModeIndicator.tsx";
import { RoutingFallbackNotice, type RoutingFallbackSignal } from "../components/RoutingFallbackNotice.tsx";
import { useGeolocation } from "../hooks/useGeolocation.ts";
import { useTranslation } from "../i18n/index.ts";
import { searchResultSubtext } from "../services/searchResultSubtext.ts";
import { pluralize } from "../i18n/plurals.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useRoutingStore } from "../stores/routingStore.ts";
import { StaleWasmInitError } from "../services/raptorWasm.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { DEFAULT_WALK_SPEED_MPS } from "@pt/shared/constants";
import { serviceDayOriginUnix, unixToServiceDate } from "@pt/shared/time";
import type { Itinerary, Leg, LegPlace, LatLon, TransportMode, BaseEndpoint } from "@pt/shared";
import type { RtComposedItinerary } from "../services/rtOverlay.ts";
import { TransportModeIcon, MODE_CONFIG } from "../components/TransportModeIcon.tsx";
import { db, type PoiIndexRecord } from "../db/index.ts";
import Dexie from "dexie";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { SearchPlaceActions, LocationTargetIcon } from "../components/Search/SearchPlaceActions.tsx";
import { useMapTapStore } from "../stores/mapTapStore.ts";
import { useSearchPickerLayout } from "../components/Search/SearchPickerLayout.ts";
import "../styles/searchPicker.css";
import { PinnedSavesSection, type ResolvedSave } from "../components/Search/PinnedSavesSection.tsx";
import { OptionalStorageChoice } from "../components/Privacy/OptionalStorageChoice.tsx";
import {
  searchSuggestions,
  searchSuggestionsStream,
  SUGGESTION_PAGE_SIZE,
  type SearchSuggestion,
} from "../services/searchSuggestions.ts";
import { resolvePoiFetchMode } from "../services/poiFetchMode.ts";
import { runViewportPrefetch } from "../services/poiSearchStream.ts";
import { buildSearchPrefetchDriver } from "../services/poiSearchDriver.ts";
import { getCityPoiTiling } from "../services/poiManifest.ts";
import { PREFETCH_EST_TILE_BYTES } from "@pt/shared/poi";
import { getPolicy } from "../stores/privacyStore.ts";
import { grantRemoteRouting, isRemoteRoutingAvailable, useCanUseRemoteRouting } from "../services/routingAccess.ts";
import { useRemoteRoutingAvailable } from "../services/remoteRoutingAvailability.ts";
import { isDeviceOnline } from "../hooks/useConnectivity.ts";
import { getActiveTileLoader } from "../services/poiSync.ts";
import { poiCityIds } from "../services/poiLoader.ts";
import { scheduleIdle } from "../utils/idle.ts";
import { recordRecent } from "../services/recents.ts";
import { ArriveByResults, ArriveByToolbar } from "../components/ArriveBy/arriveByExperiment.ts";
import { resolveTransitLegDisplay } from "../services/legEnrichment.ts";

const SearchMapPicker = lazy(() => import("../components/Search/SearchMapPicker.tsx").then(module => ({ default: module.SearchMapPicker })));

const POI_CATEGORY_ICONS: Record<string, string> = {
  airport: "\u2708\uFE0F",
  bus_terminal: "\u{1F68C}",
  cultural_venue: "\u{1F3AD}",
  hospital: "\u{1F3E5}",
  landmark: "\u{1F3DB}\uFE0F",
  mall: "\u{1F6CD}\uFE0F",
  museum: "\u{1F3DB}\uFE0F",
  park: "\u{1F333}",
  square: "\u{1F3DB}\uFE0F",
  stadium: "\u{1F3DF}\uFE0F",
  theater: "\u{1F3AD}",
  train_station: "\u{1F689}",
  university: "\u{1F393}",
  transit_entrance: "\u{1F689}",
  named_junction: "\u{1F6E4}\uFE0F",
  public_building: "\u{1F3E2}",
  named_square: "\u{1F3DB}\uFE0F",
  named_bus_stop: "\u{1F68F}",
  school: "\u{1F3EB}",
  tourism: "\u{1F4F7}",
  retail: "\u{1F6D2}",
};

function poiCategoryIcon(category: string): string {
  return POI_CATEGORY_ICONS[category] ?? "\u{1F4CD}";
}

/** Transit modes eligible for mode filtering (non-personal modes only). */
const FILTERABLE_MODES: TransportMode[] = [
  "BUS", "TROLLEYBUS", "TRAM", "METRO", "RAIL", "FERRY",
  "CABLE_TRAM", "AERIAL", "FUNICULAR", "OTHER",
];

function endpointDisplay(ep: BaseEndpoint): string {
  if (ep.kind === "stop") return ep.name;
  if (ep.kind === "geocoded") return ep.label;
  if (ep.kind === "stopGroup") return ep.label;
  return `${ep.lat.toFixed(4)}, ${ep.lon.toFixed(4)}`;
}

/**
 * Field text for an endpoint handed over from another surface. A map pin
 * carries no name, and its coords are already reduced by the privacy seam —
 * show the pin label rather than a bare coordinate pair.
 */
function handoffEndpointLabel(
  ep: BaseEndpoint,
  t: (key: string, fallback?: string) => string,
): string {
  return ep.kind === "mappoint"
    ? t("mapTap.title", "Dropped pin")
    : endpointDisplay(ep);
}

export function parseCoordinateEndpoint(query: string): BaseEndpoint | null {
  const match = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*|\s+)(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;

  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { kind: "mappoint", lat, lon };
}

/**
 * Project a service-day-seconds value to an absolute-instant ISO string.
 * When `feedTz` is known, uses the GTFS wall-clock projection in the feed tz
 * (DST-correct, cross-tz-correct). When absent (local user / no tz), falls back
 * to the legacy device-local base-date cascade.
 */
function projectToIso(
  secs: number,
  serviceDateYmd: number,
  feedTz: string | undefined,
): string {
  // GTFS `Time` counts from the service date's origin (local noon minus 12 h),
  // the instant the engine resolved the departure against. Local midnight is
  // off by an hour on a DST date, so project from the origin, not midnight.
  const tz = feedTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Date((serviceDayOriginUnix(serviceDateYmd, tz) + secs) * 1000).toISOString();
}

/**
 * Display names for the two synthesized first/last-mile walk legs. They are
 * baked into the itinerary data rather than resolved at render, so the caller
 * has to hand them in already translated — every leg-row surface reads
 * `leg.to.name` straight through.
 */
interface EndpointLabels {
  origin: string;
  destination: string;
}

export async function convertRaptorResults(
  results: RtComposedItinerary[],
  departureTime: Date,
  origin: LatLon,
  destination: LatLon,
  feedTz: string | undefined,
  queryServiceDateYmd: number,
  endpointLabels: EndpointLabels,
): Promise<Itinerary[]> {
  const allStops = await db.gtfsStops.toArray();
  const stopMap = new Map(allStops.map((s) => [s.id, s]));

  // Backfill transit-leg display fields (route short name / colour / headsign)
  // from the local GTFS DB. On-device-engine legs already carry these, but the
  // pt-serve `/plan` backend-assist fallback sends a minimal wire that omits
  // them — see `resolveTransitLegDisplay`. Routes is a small table (toArray);
  // trips is large, so only fetch the tripIds actually present in the results.
  const tripIds = new Set<string>();
  for (const it of results) {
    for (const leg of it.legs) {
      if (leg.type === "transit") tripIds.add(leg.tripId);
    }
  }
  const routeRecords = await db.gtfsRoutes.toArray();
  const routeMap = new Map(routeRecords.map((r) => [r.id, r]));
  const tripRecords = tripIds.size > 0 ? await db.gtfsTrips.bulkGet([...tripIds]) : [];
  const tripMap = new Map(
    tripRecords.filter((t): t is NonNullable<typeof t> => t != null).map((t) => [t.tripId, t]),
  );

  return results.map((itin) => {
    // Project each time once, in the feed tz, against the query service date. Overnight-fallback
    // results carry the engine's -86400-rewritten secs and project correctly against the query date
    // (CUT — the previous-day projection is algebraically identical). No per-result branch.
    const iso = (secs: number) => projectToIso(secs, queryServiceDateYmd, feedTz);
    const transitLegs: Leg[] = itin.legs.map((leg) => {
      const fromStop = stopMap.get(leg.fromStopId);
      const toStop = stopMap.get(leg.toStopId);
      const from: LegPlace = {
        name: fromStop?.name ?? leg.fromStopId,
        stopId: leg.fromStopId,
        location: fromStop
          ? { lat: fromStop.lat, lon: fromStop.lon }
          : { lat: 0, lon: 0 },
      };
      const to: LegPlace = {
        name: toStop?.name ?? leg.toStopId,
        stopId: leg.toStopId,
        location: toStop
          ? { lat: toStop.lat, lon: toStop.lon }
          : { lat: 0, lon: 0 },
      };
      const isTransit = leg.type === "transit";
      const display = isTransit ? resolveTransitLegDisplay(leg, routeMap, tripMap) : undefined;
      return {
        mode: (leg.mode ?? (isTransit ? "BUS" : "WALK")) as TransportMode,
        from,
        to,
        departureTime: iso(leg.departSecs),
        arrivalTime: iso(leg.arriveSecs),
        durationSeconds: leg.arriveSecs - leg.departSecs,
        routeShortName: display?.routeShortName,
        routeColor: display?.routeColor,
        tripId: isTransit ? leg.tripId : undefined,
        headsign: display?.headsign,
        intermediateStops: leg.intermediateStops,
        routeId: isTransit ? leg.routeId : undefined,
        approximate: isTransit ? leg.approximate : undefined,
        ...(isTransit && leg.appliedDelaySeconds !== undefined
          ? { appliedDelaySeconds: leg.appliedDelaySeconds }
          : {}),
        boardStopIdx: isTransit ? leg.boardStopIdx : undefined,
        alightStopIdx: isTransit ? leg.alightStopIdx : undefined,
        patternStopIds: isTransit ? leg.patternStopIds : undefined,
      };
    });

    const legs: Leg[] = [];

    // Synthesize first-mile walking leg from origin to first boarding stop
    if (itin.sourceWalkSecs > 0 && transitLegs.length > 0) {
      const firstLeg = transitLegs[0];
      const walkStartSecs = itin.departureSecs;
      const walkEndSecs = walkStartSecs + itin.sourceWalkSecs;
      legs.push({
        mode: "WALK" as TransportMode,
        from: { name: endpointLabels.origin, location: origin },
        to: firstLeg.from,
        departureTime: iso(walkStartSecs),
        arrivalTime: iso(walkEndSecs),
        durationSeconds: itin.sourceWalkSecs,
        ...(itin.sourceRunToCatch ? { runToCatch: true } : {}),
      });
    }

    legs.push(...transitLegs);

    // Synthesize last-mile walking leg from final alighting stop to destination
    if (itin.destWalkSecs > 0 && transitLegs.length > 0) {
      const lastLeg = transitLegs[transitLegs.length - 1];
      const walkStartSecs = itin.arrivalSecs - itin.destWalkSecs;
      const walkEndSecs = itin.arrivalSecs;
      legs.push({
        mode: "WALK" as TransportMode,
        from: lastLeg.to,
        to: { name: endpointLabels.destination, location: destination },
        departureTime: iso(walkStartSecs),
        arrivalTime: iso(walkEndSecs),
        durationSeconds: itin.destWalkSecs,
      });
    }

    return {
      legs,
      departureTime: iso(itin.departureSecs),
      arrivalTime: iso(itin.arrivalSecs),
      durationSeconds: itin.totalSecs,
      transfers: itin.transfers,
      // The walked metres themselves; seconds × 1.25 m/s overstated it for
      // anyone slower and understated a run to catch.
      walkingDistanceMeters: Math.round(itin.totalWalkMeters ?? itin.totalWalkSecs * DEFAULT_WALK_SPEED_MPS),
      ...(itin.cancelled ? { cancelled: true } : {}),
      ...(itin.timingUnreliable ? { timingUnreliable: true } : {}),
    };
  });
}

/** Service-day YYYYMMDD for a departure instant — feed tz when known
 *  (cross-tz-correct), else the device-local calendar date. Extracted so the
 *  remote-primary handler doesn't re-inline the existing block. Mirrors the
 *  inline computation already used in handleSearchOnServer / the main effect. */
/**
 * The on-device search the auto-search effect last started. `query` holds
 * every value the effect reads except `ptRouterReady`, so a re-run caused only
 * by the engine landing can be told apart from a changed query.
 */
interface OnDeviceSearchRun {
  query: readonly unknown[];
  routerReadyAtStart: boolean;
  pending: boolean;
  cancelled: boolean;
}

function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

function serviceDateYmdFor(departureTime: Date, feedTz: string | undefined): number {
  const tz = feedTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return unixToServiceDate(Math.floor(departureTime.getTime() / 1000), tz);
}

export function SearchPage() {
  const navigate = useNavigate();
  const tripStart = useTripStart(useCallback(() => navigate("/"), [navigate]));
  const [searchParams] = useSearchParams();
  const { location: userLocation, loading: locating, error: locationError } = useGeolocation();
  const requestedGpsField = useRef<"from" | "to" | null>(null);
  const gpsMode = useSettingsStore((state) => state.gpsMode);
  const { t, locale } = useTranslation();
  const endpointLabels = useMemo(
    () => ({
      origin: t("route.origin", "Origin"),
      destination: t("route.destination", "Destination"),
    }),
    [t],
  );
  const preferredAdapter = useSettingsStore((s) => s.preferredAdapter);
  const searchProvider = useSettingsStore((s) => s.searchProvider);
  const poiLooseCategories = useSettingsStore((s) => s.poiLooseCategories);
  const activeFieldOnly = useSettingsStore((s) => s.searchActiveFieldOnly);
  const keyboardFit = useSettingsStore((s) => s.searchKeyboardFit);
  const compactRows = useSettingsStore((s) => s.searchCompactRows);
  const dismissOnScroll = useSettingsStore((s) => s.searchDismissOnScroll);
  const routingMode = useSettingsStore((s) => s.routingMode);
  const routingProvider = useSettingsStore((s) => s.routingProvider);
  const ranking = useRoutingStore((s) => s.ranking);
  const setRanking = useRoutingStore((s) => s.setRanking);
  const excludedModes = useSettingsStore((s) => s.excludedModes);
  const excludedRouteGroupsByCity = useSettingsStore((s) => s.excludedRouteGroupsByCity);
  const toggleRouteGroup = useSettingsStore((s) => s.toggleRouteGroup);
  const toggleMode = useSettingsStore((s) => s.toggleMode);
  const applyCityModeDefaults = useSettingsStore((s) => s.applyCityModeDefaults);

  // Derive which transit modes exist in the current city's GTFS data
  const raptorIndex = useGtfsDataStore((s) => s.raptorIndex);
  const availableModes = useMemo<TransportMode[]>(() => {
    if (!raptorIndex) return [];
    const modesInData = new Set<TransportMode>();
    for (const route of raptorIndex.routes) {
      modesInData.add(route.mode);
    }
    return FILTERABLE_MODES.filter((m) => modesInData.has(m));
  }, [raptorIndex]);

  const [fromText, setFromText] = useState<string | null>(null);
  const [toText, setToText] = useState(
    searchParams.get("toName") ?? ""
  );
  const [fromEndpoint, setFromEndpoint] = useState<BaseEndpoint | null>(null);
  const [toEndpoint, setToEndpoint] = useState<BaseEndpoint | null>(() => {
    const lat = searchParams.get("toLat");
    const lon = searchParams.get("toLon");
    return lat && lon
      ? { kind: "mappoint", lat: parseFloat(lat), lon: parseFloat(lon) }
      : null;
  });

  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  // The engine returns up to SEARCH_MAX_RESULTS; show them a page at a time.
  const [visibleSuggestionCount, setVisibleSuggestionCount] = useState(SUGGESTION_PAGE_SIZE);
  const [suggestionStatus, setSuggestionStatus] = useState<"idle" | "searching" | "ready" | "error">("idle");
  const [itineraries, setItineraries] = useState<Itinerary[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Distinct from `searchError`: engine-class failures (the wasm engine
  // could not load / decode / plan, or no router could be built for the
  // city) flow here so the UI's `engine-error` testid surfaces only on
  // engine failures, not on generic search problems. See routingStore's
  // isEngineError + `e2e/core/wasm-engine-failure.spec.ts`.
  const [engineError, setEngineError] = useState<string | null>(null);
  const [engineFailureKind, setEngineFailureKind] =
    useState<import("../services/engineFailure.ts").EngineFailureKind | null>(null);
  const [paginationTime, setPaginationTime] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [routingFallback, setRoutingFallback] = useState<RoutingFallbackSignal | null>(null);
  const [serverEmpty, setServerEmpty] = useState(false);
  const [failedTransitousPrimaryKey, setFailedTransitousPrimaryKey] =
    useState<string | null>(null);
  const [activeField, setActiveField] = useState<"from" | "to" | null>(
    toText ? null : "to"
  );
  const [mapPickerField, setMapPickerField] = useState<"from" | "to" | null>(null);
  const activeQuery = activeField === "from" ? (fromText ?? "") : activeField === "to" ? toText : "";
  useSearchPickerLayout(mapPickerField !== null || (activeField !== null && keyboardFit));
  const searchAbortRef = useRef<AbortController | null>(null);
  const fromInputRef = useRef<HTMLInputElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const stopResultsRef = useRef<HTMLDivElement>(null);
  const pendingFieldFocusRef = useRef<"from" | "to" | null>(null);
  const fromTouchedRef = useRef(false);
  // Set when an endpoint arrives from another surface (map long-press), so
  // the destination autofocus below doesn't reopen the suggestion panel over
  // a field the handoff already filled.
  const endpointHandoffRef = useRef(false);
  // Always holds the current query identity so handleSearchOnServer can detect
  // whether it has become stale by the time the remote /plan promise settles.
  // The tuple mirrors the main auto-search effect's re-fire triggers (from/to/
  // paginationTime AND ranking/excludedModes — see that effect's dep array), so
  // a ranking flip or mode-chip toggle mid-RTT correctly marks the in-flight
  // remote result stale.
  const latestQueryRef = useRef<{
    from: typeof fromEndpoint; to: typeof toEndpoint; at: typeof paginationTime;
    ranking: typeof ranking; excludedModes: typeof excludedModes; excludedRouteGroupsByCity: typeof excludedRouteGroupsByCity;
  }>({
    from: fromEndpoint, to: toEndpoint, at: paginationTime, ranking, excludedModes, excludedRouteGroupsByCity,
  });
  latestQueryRef.current = { from: fromEndpoint, to: toEndpoint, at: paginationTime, ranking, excludedModes, excludedRouteGroupsByCity };
  // Identity of the last remote-primary query we fired, so a change in only the
  // on-device-readiness deps (raptorReady/ptRouterReady/gtfsSyncing — present in
  // the effect for the on-device path) does NOT re-leave the device. Reference
  // comparison over the same 5 fields `stale()` uses.
  const remotePrimaryFiredRef = useRef<{
    city: typeof cityId; from: typeof fromEndpoint; to: typeof toEndpoint;
    at: typeof paginationTime; ranking: typeof ranking; excludedModes: typeof excludedModes; excludedRouteGroupsByCity: typeof excludedRouteGroupsByCity;
  } | null>(null);

  // Ensure GTFS data is initialized when Search is accessed directly (cold load)
  const cityId = useCityStore((s) => s.activeCity.id);
  const cityRouteGroups = useCityStore((s) => s.activeCity.routeGroups);
  const availableRouteGroups = useMemo(() => {
    const groups = cityRouteGroups ?? [];
    const present = new Set(raptorIndex?.routes.map((r) => routeGroupFor(r, groups)?.id));
    return groups.filter((g) => present.has(g.id));
  }, [cityRouteGroups, raptorIndex]);
  const feedTz = useCityStore((s) => s.activeCity.tz);
  const cityDefaultExcludedModes = useCityStore((s) => s.activeCity.defaultExcludedModes);
  // Standing remote use needs an allowed routing flow; a per-search grant on
  // an on-device setup must not turn into automatic remote searches.
  const remoteAllowed = useCanUseRemoteRouting("operator") && routingMode !== "on-device";
  const transitousAllowed = useCanUseRemoteRouting("transitous") && routingMode !== "on-device";
  // Availability of the remote routing source — a cached,
  // fail-closed up/down hint refreshed OFF the search hot path. Gates only the
  // recovery affordance; the standing modes are NOT gated on it.
  const remoteRoutingAvailable = useRemoteRoutingAvailable(cityId);
  const raptorReady = useGtfsDataStore((s) => s.raptorIndex !== null);
  const gtfsSyncing = useGtfsDataStore((s) => s.syncing);
  // Subscribe to ptRouter so the auto-search effect re-fires when the
  // wasm engine's PtRouter lands. A search that already settled with an
  // engine error (the wait for the build timed out, or the build failed and a
  // later one succeeded) re-runs then; that is the only re-fire trigger. A
  // search still waiting for the build is kept instead (see the effect).
  const ptRouterReady = useGtfsDataStore((s) => s.ptRouter !== null);
  const onDeviceSearchRef = useRef<OnDeviceSearchRun | null>(null);
  // The auto-search effect keeps a waiting search across its own re-run, so
  // its cleanup does not cancel; the search is cancelled here on unmount.
  useEffect(() => {
    const ref = onDeviceSearchRef;
    return () => {
      if (ref.current) ref.current.cancelled = true;
      ref.current = null;
    };
  }, []);
  useEffect(() => {
    if (preferredAdapter === "raptor") {
      useGtfsDataStore.getState().init(cityId);
    }
  }, [preferredAdapter, cityId]);

  // Seed the active city's default-excluded modes (e.g. Vilnius ferry) before
  // the auto-search effect below fires, so the first itinerary search already
  // skips them. Idempotent per session; the chip stays toggleable.
  useEffect(() => {
    applyCityModeDefaults(cityId, cityDefaultExcludedModes ?? []);
  }, [cityId, cityDefaultExcludedModes, applyCityModeDefaults]);

  // Use user location as from by default (only on initial mount, before user edits)
  useEffect(() => {
    if (userLocation && !fromEndpoint && fromText === null && !fromTouchedRef.current) {
      setFromEndpoint({ kind: "mappoint", lat: userLocation.lat, lon: userLocation.lon });
    }
  }, [userLocation, fromEndpoint, fromText]);

  // Resolve fromStopId / toStopId query params against the local GTFS stops
  // table (best-effort URL-driven prefill). Stop-ID takes precedence over the
  // coord-based (toLat/toLon/toName) params handled above. Re-runs once GTFS
  // data becomes available so a cold-load with stop-id params still resolves.
  useEffect(() => {
    const fromStopId = searchParams.get("fromStopId");
    const toStopId = searchParams.get("toStopId");
    if (!fromStopId && !toStopId) return;
    // If a RAPTOR sync is in-flight, wait for it to finish before looking
    // up the stops; otherwise the lookup hits an empty IDB and silently
    // no-ops. (Tests that pre-populate db.gtfsStops directly never see
    // gtfsSyncing=true, so they fall through immediately.)
    if (preferredAdapter === "raptor" && gtfsSyncing) return;

    let cancelled = false;
    (async () => {
      if (fromStopId) {
        const stop = await db.gtfsStops.get(fromStopId);
        if (stop && !cancelled) {
          fromTouchedRef.current = true;
          setFromText(stop.name);
          setFromEndpoint({
            kind: "stop",
            stopId: stop.id,
            name: stop.name,
            lat: stop.lat,
            lon: stop.lon,
          });
        }
      }
      if (toStopId) {
        const stop = await db.gtfsStops.get(toStopId);
        if (stop && !cancelled) {
          setToText(stop.name);
          setToEndpoint({
            kind: "stop",
            stopId: stop.id,
            name: stop.name,
            lat: stop.lat,
            lon: stop.lon,
          });
        }
      }
    })().catch(() => {
      // Best-effort: swallow any lookup errors so we don't block other init.
    });

    return () => {
      cancelled = true;
    };
  }, [searchParams, gtfsSyncing, preferredAdapter]);

  // Endpoints handed off from a surface outside this page — today the map
  // long-press action sheet, which reduces the pin through `mapTapStore`,
  // writes it to `routingStore` and navigates here. Consume-once: hydrate the
  // field, then clear the store slot so a later visit to /search can't
  // re-apply a stale pin. Deliberately NOT run through `captureRecent` — a
  // dropped pin is not a searched-for place and must not reach recentLocations.
  const pendingOrigin = useRoutingStore((s) => s.origin);
  const pendingDestination = useRoutingStore((s) => s.destination);
  useEffect(() => {
    if (!pendingOrigin && !pendingDestination) return;
    if (pendingOrigin) {
      // Marks the from field as user-set so the live-GPS default effect
      // doesn't overwrite the pin on the next geolocation update.
      fromTouchedRef.current = true;
      setFromText(handoffEndpointLabel(pendingOrigin, t));
      setFromEndpoint(pendingOrigin);
    }
    if (pendingDestination) {
      endpointHandoffRef.current = true;
      setToText(handoffEndpointLabel(pendingDestination, t));
      setToEndpoint(pendingDestination);
    }
    // A pinned origin leaves the destination to fill in, so open that field.
    // A pinned destination pairs with the live-GPS origin, so open nothing —
    // and if there is no fix, `TripIncompleteNotice` asks for the origin.
    setActiveField(pendingDestination ? null : "to");
    useRoutingStore.setState({ origin: null, destination: null });
  }, [pendingOrigin, pendingDestination, t]);

  // Per-event "Search on the server": re-run the HELD query
  // (same from/to/paginationTime) through the gated pt-serve remote planner via
  // `{ remote: true }`, and refresh local itineraries/engineError/searchError
  // state exactly as the auto-search effect below does. Only reachable when
  // `remoteAllowed` is true (the button is gated by the privacy ceiling). Also
  // reused by the main effect as the standing-choice auto-fallback target in
  // `provider-fallback` mode — hence declared BEFORE that effect.
  const handleSearchOnServer = useCallback(() => {
    if (!fromEndpoint || !toEndpoint) return;
    const currentCity = useCityStore.getState().activeCity;
    if (excludedRouteIdsForGroups(useGtfsDataStore.getState().raptorIndex?.routes ?? [], currentCity.routeGroups ?? [],
      useSettingsStore.getState().excludedRouteGroupsByCity[currentCity.id] ?? []).length > 0) {
      setSearchError(t("search.vehicle_filter_local", "Use on-device planning for bus and minibus filters."));
      setLoading(false);
      return;
    }
    const at = { from: fromEndpoint, to: toEndpoint, at: paginationTime, ranking, excludedModes, excludedRouteGroupsByCity };
    // The remote /plan RTT can outlive a query change (the main effect re-fires
    // on endpoint/time/ranking/excludedModes change). Bail if the user has moved
    // on so a stale remote result can't clobber the newer query's state — mirrors
    // the main effect's cancel guard, over the SAME re-fire triggers so a
    // ranking flip or mode-chip toggle mid-RTT isn't misread as fresh.
    const stale = () =>
      latestQueryRef.current.from !== at.from ||
      latestQueryRef.current.to !== at.to ||
      latestQueryRef.current.at !== at.at ||
      latestQueryRef.current.ranking !== at.ranking ||
      latestQueryRef.current.excludedModes !== at.excludedModes ||
      latestQueryRef.current.excludedRouteGroupsByCity !== at.excludedRouteGroupsByCity;
    const departureTime = paginationTime ?? new Date();
    const fromCoord: LatLon = { lat: fromEndpoint.lat, lon: fromEndpoint.lon };
    const toCoord: LatLon = { lat: toEndpoint.lat, lon: toEndpoint.lon };
    setLoading(true);
    setSearchError(null);
    setEngineError(null);
    setEngineFailureKind(null);
    setRoutingFallback(null);
    setServerEmpty(false);
    setActiveField(null);
    useRoutingStore
      .getState()
      .search(fromEndpoint, toEndpoint, departureTime, { remote: true })
      .then(() => {
        if (stale()) return;
        const { results, error, engineError: engineErr, engineFailureKind: kind } = useRoutingStore.getState();
        if (engineErr) {
          setItineraries([]);
          setEngineError(engineErr);
          setEngineFailureKind(kind);
          return;
        }
        if (error) {
          setItineraries([]);
          setSearchError(error);
          return;
        }
        return convertRaptorResults(results, departureTime, fromCoord, toCoord, feedTz, serviceDateYmdFor(departureTime, feedTz), endpointLabels);
      })
      .then((converted) => {
        if (!stale() && converted) setItineraries(converted);
      })
      .catch((err) => {
        if (stale()) return;
        setItineraries([]);
        setSearchError(err instanceof Error ? err.message : "Route search failed");
      })
      .finally(() => {
        if (!stale()) setLoading(false);
      });
  }, [fromEndpoint, toEndpoint, paginationTime, ranking, excludedModes, excludedRouteGroupsByCity, feedTz, endpointLabels]);

  // Remote-primary: the SERVER is the primary planner.
  // On any plan() rejection we fall back to on-device and SIGNAL it (the banner).
  // A reachable-but-empty remote result is the distinct `serverEmpty` state and
  // does NOT retry on-device. Only reached when remoteAllowed (the effect
  // computes `remotePrimary` with the ceiling gate); the gateRemoteRouting
  // dispatch backstop is the final guard. Uses `stale()` (ref-based), so it is
  // safe to invoke outside the effect's cancel lifecycle.
  const handleRemotePrimarySearch = useCallback(() => {
    if (!fromEndpoint || !toEndpoint) return;
    const currentCity = useCityStore.getState().activeCity;
    if (excludedRouteIdsForGroups(useGtfsDataStore.getState().raptorIndex?.routes ?? [], currentCity.routeGroups ?? [],
      useSettingsStore.getState().excludedRouteGroupsByCity[currentCity.id] ?? []).length > 0) {
      setSearchError(t("search.vehicle_filter_local", "Use on-device planning for bus and minibus filters."));
      setLoading(false);
      return;
    }
    const at = { from: fromEndpoint, to: toEndpoint, at: paginationTime, ranking, excludedModes, excludedRouteGroupsByCity };
    const stale = () =>
      latestQueryRef.current.from !== at.from ||
      latestQueryRef.current.to !== at.to ||
      latestQueryRef.current.at !== at.at ||
      latestQueryRef.current.ranking !== at.ranking ||
      latestQueryRef.current.excludedModes !== at.excludedModes ||
      latestQueryRef.current.excludedRouteGroupsByCity !== at.excludedRouteGroupsByCity;
    const departureTime = paginationTime ?? new Date();
    const fromCoord: LatLon = { lat: fromEndpoint.lat, lon: fromEndpoint.lon };
    const toCoord: LatLon = { lat: toEndpoint.lat, lon: toEndpoint.lon };

    // The on-device fallback leg (server failed): re-run on-device and surface it.
    const runOnDeviceFallback = () => {
      useRoutingStore
        .getState()
        .search(fromEndpoint, toEndpoint, departureTime)
        .then(() => {
          if (stale()) return;
          const { results, error, engineError: engineErr, engineFailureKind: kind } = useRoutingStore.getState();
          if (engineErr) { setItineraries([]); setEngineError(engineErr); setEngineFailureKind(kind); return; }
          if (error) { setItineraries([]); setSearchError(error); return; }
          return convertRaptorResults(results, departureTime, fromCoord, toCoord, feedTz, serviceDateYmdFor(departureTime, feedTz), endpointLabels);
        })
        .then((converted) => { if (!stale() && converted) setItineraries(converted); })
        .catch((err) => {
          if (stale()) return;
          // Superseded on-device search (reset/city-switch/refresh) — drop it
          // silently rather than showing a search error.
          if (err instanceof StaleWasmInitError) return;
          setItineraries([]);
          setSearchError(err instanceof Error ? err.message : "Route search failed");
        })
        .finally(() => { if (!stale()) setLoading(false); });
    };

    setLoading(true);
    setSearchError(null);
    setEngineError(null);
    setEngineFailureKind(null);
    setRoutingFallback(null);
    setServerEmpty(false);
    setActiveField(null);

    useRoutingStore
      .getState()
      .search(fromEndpoint, toEndpoint, departureTime, { remote: true })
      .then(() => {
        if (stale()) return;
        const { results, error, engineError: engineErr } = useRoutingStore.getState();
        if (error != null || engineErr != null) {
          // plan() rejection: fall back to on-device. The local index is
          // loaded (the effect's GTFS-ready guard gates this path), so on-device
          // can always be attempted; its own engine/empty outcome is surfaced by
          // runOnDeviceFallback. isDeviceOnline() only picks the banner copy (,
          // an optimization hint) — the fallback fires on the rejection, never on
          // the flag.
          setRoutingFallback(isDeviceOnline() ? "fallback-server" : "fallback-offline");
          runOnDeviceFallback(); // owns `loading` until it settles
          return;
        }
        // Remote OK. Reachable-but-empty — results.length===0 with error==null is
        // the ONLY empty signal — is a distinct state: show "server has no
        // route" and do NOT retry on-device (it may also be empty / stale).
        if (results.length === 0) {
          setServerEmpty(true);
          setItineraries([]);
          setLoading(false);
          return;
        }
        return convertRaptorResults(results, departureTime, fromCoord, toCoord, feedTz, serviceDateYmdFor(departureTime, feedTz), endpointLabels)
          .then((converted) => {
            if (stale()) return;
            setItineraries(converted);
            setLoading(false);
          });
      })
      .catch((err) => {
        if (stale()) return;
        setItineraries([]);
        setSearchError(err instanceof Error ? err.message : "Route search failed");
        setLoading(false);
      });
  }, [fromEndpoint, toEndpoint, paginationTime, ranking, excludedModes, excludedRouteGroupsByCity, feedTz, endpointLabels]);

  const hasRouteRestrictions = availableRouteGroups.some((g) => (excludedRouteGroupsByCity[cityId] ?? []).includes(g.id));
  const fromLat = fromEndpoint?.lat;
  const fromLon = fromEndpoint?.lon;
  const toLat = toEndpoint?.lat;
  const toLon = toEndpoint?.lon;
  const transitousDepartAtIso = useMemo(
    () => (paginationTime ?? new Date()).toISOString(),
    [paginationTime, fromLat, fromLon, toLat, toLon],
  );
  const transitousQueryKey =
    fromLat != null && fromLon != null && toLat != null && toLon != null
      ? `${fromLat}:${fromLon}:${toLat}:${toLon}:${transitousDepartAtIso}`
      : null;

  // Auto-search routes if both locations are set.
  // When preferredAdapter is "raptor", uses on-device RAPTOR engine (no network calls).
  // Otherwise falls back to server-side adapter (e.g. MOTIS via Transitous API).
  useEffect(() => {
    const query = [fromEndpoint, toEndpoint, preferredAdapter, raptorReady, gtfsSyncing, cityId, paginationTime, excludedModes, excludedRouteGroupsByCity, ranking, feedTz, hasRouteRestrictions, routingMode, routingProvider, remoteAllowed, transitousAllowed, transitousQueryKey, failedTransitousPrimaryKey, handleSearchOnServer, handleRemotePrimarySearch, endpointLabels];
    const prev = onDeviceSearchRef.current;
    // The engine landing re-runs this effect. A search that started before it
    // was ready waits for that same build (`withOnDeviceRouter` awaits
    // `ensureWasmReady`) and then plans on it, so while it is still pending for
    // an unchanged query, a new search would only repeat it and drop its
    // result: keep it. Every other re-run supersedes the search in flight.
    if (ptRouterReady && prev?.pending && !prev.routerReadyAtStart && sameValues(prev.query, query)) return;
    if (prev) prev.cancelled = true;
    onDeviceSearchRef.current = null;
    if (!fromEndpoint || !toEndpoint) return;
    const operatorRemotePrimary =
      routingMode === "remote-primary" && !hasRouteRestrictions &&
      routingProvider === "operator" &&
      remoteAllowed;
    const transitousRemotePrimary =
      routingMode === "remote-primary" && !hasRouteRestrictions &&
      routingProvider === "transitous" &&
      transitousAllowed &&
      transitousQueryKey !== null &&
      failedTransitousPrimaryKey !== transitousQueryKey;
    // Wait for GTFS data before attempting a RAPTOR search — for EVERY mode, including
    // remote-primary. The remote `{remote:true}` path still resolves coords→stops and
    // composes/overlays via the local index (routingStore.search short-circuits on a null
    // raptorIndex; the orchestrator owns resolve/compose) — only the plan() step is remote. Firing
    // the server without the index would never reach the network and would misreport a healthy
    // server as unavailable. A genuinely index-free (thin-client) remote path is the Phase-2
    // coordinate RoutingSource.
    if (preferredAdapter === "raptor") {
      // Read latest store state (not the render closure) to catch the
      // synchronous syncing=true set by the init effect that runs first.
      const { syncing, raptorIndex, loadedCityId } = useGtfsDataStore.getState();
      if (!raptorIndex || syncing || loadedCityId !== cityId) return;
    }
    // remote-primary: fire the server FIRST (the on-device index is loaded, so a
    // server failure can always fall back to it). Dedup re-fires that come only
    // from on-device-readiness deps flipping (e.g. ptRouter landing) — those don't
    // change the query, and re-leaving the device per readiness flip is wasteful
    // egress. Keyed by city + the 5 query fields. Checked BEFORE the shared
    // loading/error reset so a skip can't strand `loading`; handleRemotePrimarySearch
    // owns its own reset + lifecycle.
    if (operatorRemotePrimary) {
      const f = remotePrimaryFiredRef.current;
      const same = f != null &&
        f.city === cityId && f.from === fromEndpoint && f.to === toEndpoint &&
        f.at === paginationTime && f.ranking === ranking && f.excludedModes === excludedModes && f.excludedRouteGroupsByCity === excludedRouteGroupsByCity;
      if (same) return;
      remotePrimaryFiredRef.current = { city: cityId, from: fromEndpoint, to: toEndpoint, at: paginationTime, ranking, excludedModes, excludedRouteGroupsByCity };
      handleRemotePrimarySearch();
      return;
    }
    if (transitousRemotePrimary) {
      remotePrimaryFiredRef.current = null;
      setLoading(false);
      setSearchError(null);
      setEngineError(null);
      setEngineFailureKind(null);
      setRoutingFallback(null);
      setServerEmpty(false);
      setItineraries([]);
      setActiveField(null);
      return;
    }
    // Not remote-primary: clear the dedup latch so a later switch BACK to
    // remote-primary on the same held query re-fires the server (a flip-away-and-
    // back must not be silently suppressed by a stale latch).
    remotePrimaryFiredRef.current = null;
    // `ptRouterReady` is in the dep list below. On the happy path the search
    // waits for the build and the re-run when the router lands is skipped
    // above. On the failure path (503 / corrupt bytes) ptRouter stays null,
    // re-fire never happens, and the original engine-error surface
    // remains — which is what wasm-engine-failure.spec.ts asserts.
    const run: OnDeviceSearchRun = { query, routerReadyAtStart: ptRouterReady, pending: true, cancelled: false };
    let delegatedToRemote = false;
    setLoading(true);
    setSearchError(null);
    setEngineError(null);
    setEngineFailureKind(null);
    setRoutingFallback(null);
    setServerEmpty(false);
    setActiveField(null);

    if (preferredAdapter === "raptor") {
      onDeviceSearchRef.current = run;
      const departureTime = paginationTime ?? new Date();
      const fromCoord: LatLon = { lat: fromEndpoint.lat, lon: fromEndpoint.lon };
      const toCoord: LatLon = { lat: toEndpoint.lat, lon: toEndpoint.lon };
      useRoutingStore
        .getState()
        .search(fromEndpoint, toEndpoint, departureTime)
        .then(() => {
          if (run.cancelled) return;
          const { results, error, engineError: engineErr, engineFailureKind: kind } = useRoutingStore.getState();
          // Auto-re-runs on the server when the ON-DEVICE attempt fails or is
          // empty (the setting is the standing choice).
          // A *remote*-empty result must NOT loop back ( reachable-but-empty);
          // that non-loop holds because `handleSearchOnServer` settles itineraries
          // to `[]` and this effect doesn't re-fire on an unchanged query.
          if (
            routingMode === "provider-fallback" &&
            routingProvider === "operator" &&
            remoteAllowed &&
            (engineErr != null || error != null || results.length === 0)
          ) {
            delegatedToRemote = true;
            handleSearchOnServer();
            return;
          }
          // Engine errors take precedence — they mean the routing engine
          // itself failed (wasm load/decode/dispatch); recover differs from
          // generic search errors. Set both null on success.
          if (engineErr) {
            setItineraries([]);
            setEngineError(engineErr);
            setEngineFailureKind(kind);
            return;
          }
          if (error) {
            setItineraries([]);
            setSearchError(error);
            return;
          }
          return convertRaptorResults(results, departureTime, fromCoord, toCoord, feedTz, serviceDateYmdFor(departureTime, feedTz), endpointLabels);
        })
        .then((converted) => {
          if (!run.cancelled && converted) setItineraries(converted);
        })
        .catch((err) => {
          if (run.cancelled) return;
          // A stale wasm init means a reset/city-switch/refresh superseded this
          // search; a fresh one is already in flight. Drop it silently — do NOT
          // show an error surface.
          if (err instanceof StaleWasmInitError) return;
          setItineraries([]);
          setSearchError(err instanceof Error ? err.message : "Route search failed");
        })
        .finally(() => {
          run.pending = false;
          if (!run.cancelled && !delegatedToRemote) setLoading(false);
        });
    } else {
      // Non-RAPTOR adapters removed — all search goes through on-device RAPTOR.
      // Backend-assist mode (stop-to-stop) is handled internally by SearchOrchestrator
      // and only sends stop IDs, never user coordinates.
      setSearchError("On-device routing not available. Check GTFS data.");
      setLoading(false);
    }

}, [fromEndpoint, toEndpoint, preferredAdapter, raptorReady, ptRouterReady, gtfsSyncing, cityId, paginationTime, excludedModes, excludedRouteGroupsByCity, ranking, feedTz, hasRouteRestrictions, routingMode, routingProvider, remoteAllowed, transitousAllowed, transitousQueryKey, failedTransitousPrimaryKey, handleSearchOnServer, handleRemotePrimarySearch, endpointLabels]);

  // The RECOVERY affordance (engine-failure "Search on the server") is the no-wasm user's only
  // route — gate on the privacy ceiling ONLY, never on the availability probe. If the source is
  // truly down, the real plan() rejection drives the signalled fallback; a wrong/transient probe
  // must never strand the user with no action.
  // The explicit "Search on the server" click is the action that allows it.
  const remoteOffered = isRemoteRoutingAvailable("operator");
  const handleSearchOnServerRequest = useCallback(() => {
    if (grantRemoteRouting("operator", "contextual")) handleSearchOnServer();
  }, [handleSearchOnServer]);
  const remoteSearch = remoteOffered && routingProvider === "operator"
    ? { onSearchOnServer: handleSearchOnServerRequest }
    : undefined;
  // The empty-state nicety (on-device ran and found nothing) — cheap to suppress
  // on a hint, so it DOES gate on availability (don't offer a dead button).
  const emptyRemoteSearch =
    remoteOffered &&
    routingProvider === "operator" &&
    remoteRoutingAvailable
    ? { onSearchOnServer: handleSearchOnServerRequest }
    : undefined;

  const handleTransitousPrimaryFallback = useCallback(() => {
    if (transitousQueryKey) {
      setFailedTransitousPrimaryKey(transitousQueryKey);
    }
  }, [transitousQueryKey]);

  // Standing transitous dispatch. RouteResults mounts this surface for a
  // remote-primary query immediately, or after an on-device fallback miss.
  // The selected provider is inert whenever either privacy gate closes.
  const transitousProps = useMemo(
    () =>
      routingProvider === "transitous" &&
      routingMode !== "on-device" &&
      transitousAllowed &&
      !(
        routingMode === "remote-primary" && !hasRouteRestrictions &&
        failedTransitousPrimaryKey === transitousQueryKey
      ) &&
      fromLat != null &&
      fromLon != null &&
      toLat != null &&
      toLon != null
        ? {
            from: { lat: fromLat, lon: fromLon },
            to: { lat: toLat, lon: toLon },
            departAtIso: transitousDepartAtIso,
            feedTz,
            onFallback:
              routingMode === "remote-primary"
                ? handleTransitousPrimaryFallback
                : undefined,
          }
        : undefined,
    [
      routingProvider,
      routingMode,
      transitousAllowed,
      fromLat,
      fromLon,
      toLat,
      toLon,
      transitousDepartAtIso,
      transitousQueryKey,
      failedTransitousPrimaryKey,
      feedTz,
      handleTransitousPrimaryFallback,
    ],
  );

  useEffect(() => {
    if (!activeField || pendingFieldFocusRef.current !== activeField) return;
    pendingFieldFocusRef.current = null;
    const input = activeField === "from" ? fromInputRef.current : toInputRef.current;
    input?.focus();
  }, [activeField]);

  // Autofocus only a newly opened empty journey. Later text changes (notably
  // swapping an empty/GPS field into To) are not requests to open the picker.
  useEffect(() => {
    if (endpointHandoffRef.current) return;
    if (!toText && toInputRef.current) {
      toInputRef.current.focus();
    }
  }, []);

  // One request identity per field/query/provider. Cleanup aborts immediately on
  // edits, field switches, selection and unmount, including during the debounce.
  useEffect(() => {
    if (!activeField) return;
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSuggestions([]);
    setSuggestionStatus(activeQuery.trim() ? "searching" : "idle");
    setVisibleSuggestionCount(SUGGESTION_PAGE_SIZE);
    const accept = (rows: SearchSuggestion[]) => {
      if (!controller.signal.aborted) {
        setSuggestions(rows);
        if (rows.length > 0) setSuggestionStatus("ready");
      }
    };
    const timer = setTimeout(() => {
      const mode = resolvePoiFetchMode(cityId);
      let request: Promise<unknown>;
      if (!activeQuery.trim() || mode !== "server-side") {
        const driver = mode === "lazy-tile" ? buildSearchPrefetchDriver(cityId, {
          poiCityIds,
          getTiling: getCityPoiTiling,
          getLoader: getActiveTileLoader,
          getViewportBbox: () => {
            const c = useCityStore.getState().activeCity;
            return {
              minLat: c.bbox.minLat, maxLat: c.bbox.maxLat,
              minLon: c.bbox.minLon, maxLon: c.bbox.maxLon,
            };
          },
          readLandedRows: async (poiCities: string[]) => {
            const rows: PoiIndexRecord[] = [];
            for (const pc of poiCities) {
              const recs = await db.poiIndex
                .where("[cityId+name]")
                .between([pc, Dexie.minKey], [pc, Dexie.maxKey])
                .filter((r) => r.loadSource === "tile")
                .toArray();
              rows.push(...recs);
            }
            return rows;
          },
          scheduleIdle,
          runPrefetch: runViewportPrefetch,
          getPacing: () => ({
            budgetBytes: getPolicy().m11TileCacheBudgetBytes,
            estTileBytes: PREFETCH_EST_TILE_BYTES,
          }),
        }) : undefined;
        request = searchSuggestionsStream(
          activeQuery, cityId, userLocation ?? null, controller.signal, searchProvider,
          {
            onResults: accept,
            driver,
            isListboxFocused: () => document.activeElement?.getAttribute("role") === "searchbox"
              || document.activeElement?.closest("[role=listbox]") != null,
          },
        );
      } else {
        request = searchSuggestions(activeQuery, cityId, userLocation ?? null, controller.signal, searchProvider).then(accept);
      }
      void request.then(() => {
        if (!controller.signal.aborted) setSuggestionStatus("ready");
      }).catch((err) => {
        if (controller.signal.aborted) return;
        console.warn("Search suggestions failed:", err);
        setSuggestions([]);
        setSuggestionStatus("error");
      });
    }, activeQuery.trim() ? 300 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [activeField, activeQuery, cityId, searchProvider, poiLooseCategories, userLocation?.lat, userLocation?.lon]);

  // Capture a committed endpoint as a recent (privacy-axis gated inside
  // recordRecent; no-ops when the axis is "off"). Excludes live-GPS and
  // URL-prefill commits by construction — those paths never call this.
  const captureRecent = useCallback((ep: BaseEndpoint, field: "from" | "to") => {
    void recordRecent(ep, { usedAsOrigin: field === "from" }).catch(() => {});
  }, []);

  function handleSearch(query: string, field: "from" | "to") {
    const typedEndpoint = parseCoordinateEndpoint(query);

    if (field === "from") {
      // Once the user edits From, an empty query means “choose a place”, not
      // permission to silently restore GPS. The picker has an explicit GPS action.
      fromTouchedRef.current = true;
      setFromText(query);
      // Free-text edits clear the previously selected endpoint immediately.
      // A raw lat/lon pair is the one exception: it resolves straight to a mappoint.
      setFromEndpoint(typedEndpoint);
    } else {
      setToText(query);
      setToEndpoint(typedEndpoint);
    }
    // A raw lat/lon pair resolves straight to a committed endpoint — record it.
    if (typedEndpoint) captureRecent(typedEndpoint, field);
    setItineraries([]);
    setLoading(false);

    setSuggestions([]);
    setSuggestionStatus(query.trim() ? "searching" : "idle");
  }

  function chooseOnMap() {
    if (!activeField) return;
    useMapTapStore.getState().clear();
    setMapPickerField(activeField);
    closePicker();
  }

  function selectMapPoint(endpoint: BaseEndpoint) {
    if (mapPickerField === "from") {
      fromTouchedRef.current = true;
      setFromText(handoffEndpointLabel(endpoint, t));
      setFromEndpoint(endpoint);
    } else {
      setToText(handoffEndpointLabel(endpoint, t));
      setToEndpoint(endpoint);
    }
    setMapPickerField(null);
    // A dropped pin is not a typed/selected search result; keep it out of recents.
    closePicker();
  }

  function cancelMapPicker() {
    const field = mapPickerField;
    setMapPickerField(null);
    if (field) openField(field);
  }

  useEffect(() => {
    if (requestedGpsField.current !== activeField || locationError) requestedGpsField.current = null;
    if (userLocation && activeField && requestedGpsField.current === activeField) {
      requestedGpsField.current = null;
      useCurrentLocation();
    }
  }, [userLocation, activeField, locationError]);

  function useCurrentLocation() {
    if (!activeField || gpsMode === "disabled") return;
    if (!userLocation) {
      requestedGpsField.current = activeField;
      if (!liveLocation.request("locate")) requestedGpsField.current = null;
      return;
    }
    const endpoint: BaseEndpoint = { kind: "mappoint", lat: userLocation.lat, lon: userLocation.lon };
    if (activeField === "from") {
      fromTouchedRef.current = false;
      setFromText(null);
      setFromEndpoint(endpoint);
    } else {
      setToText(t("search.my_location", "My location"));
      setToEndpoint(endpoint);
    }
    // GPS is not an optional-history event.
    closePicker();
  }

  function openField(field: "from" | "to") {
    pendingFieldFocusRef.current = field;
    setActiveField(field);
  }

  function closePicker() {
    searchAbortRef.current?.abort();
    fromInputRef.current?.blur();
    toInputRef.current?.blur();
    setSuggestions([]);
    setActiveField(null);
  }

  function dismissKeyboard() {
    const input = document.activeElement;
    if (input === fromInputRef.current || input === toInputRef.current) (input as HTMLInputElement).blur();
  }

  function selectSave(save: ResolvedSave) {
    searchAbortRef.current?.abort();
    dismissKeyboard();
    setSuggestions([]);
    if (save.destination) {
      // Pair save: fill both fields regardless of which one had focus.
      const originName = endpointDisplay(save.origin);
      const destName = endpointDisplay(save.destination);
      setFromText(originName);
      setFromEndpoint(save.origin);
      setToText(destName);
      setToEndpoint(save.destination);
      fromTouchedRef.current = true;
      captureRecent(save.origin, "from");
      captureRecent(save.destination, "to");
      setActiveField(null);
      return;
    }
    const name = save.alias || endpointDisplay(save.origin);
    if (activeField === "from") {
      setFromText(name);
      setFromEndpoint(save.origin);
      fromTouchedRef.current = true;
    } else {
      setToText(name);
      setToEndpoint(save.origin);
    }
    captureRecent(save.origin, activeField === "from" ? "from" : "to");
    setActiveField(null);
  }

  function selectSuggestion(suggestion: SearchSuggestion) {
    searchAbortRef.current?.abort();
    dismissKeyboard();
    let ep: BaseEndpoint;
    let name: string;

    if (suggestion.kind === "stop") {
      ep = {
        kind: "stop",
        stopId: suggestion.stopId,
        name: suggestion.name,
        lat: suggestion.lat,
        lon: suggestion.lon,
      };
      name = suggestion.name;
    } else if (suggestion.kind === "stopGroup") {
      ep = {
        kind: "stopGroup",
        stopIds: suggestion.stopIds,
        lat: suggestion.lat,
        lon: suggestion.lon,
        label: suggestion.name,
      };
      name = suggestion.name;
    } else {
      ep = {
        kind: "geocoded",
        lat: suggestion.lat,
        lon: suggestion.lon,
        label: suggestion.label,
        provider: "bundled",
        confidence: suggestion.confidence,
      };
      name = suggestion.label;
    }

    if (activeField === "from") {
      setFromText(name);
      setFromEndpoint(ep);
    } else {
      setToText(name);
      setToEndpoint(ep);
    }
    captureRecent(ep, activeField === "from" ? "from" : "to");
    setSuggestions([]);
    setActiveField(null);
  }

  function handleEarlier() {
    if (itineraries.length === 0) return;
    const earliest = new Date(itineraries[0].departureTime);
    earliest.setMinutes(earliest.getMinutes() - 30);
    setPaginationTime(earliest);
  }

  function handleLater() {
    if (itineraries.length === 0) return;
    const latest = new Date(itineraries[itineraries.length - 1].departureTime);
    latest.setMinutes(latest.getMinutes() + 1);
    setPaginationTime(latest);
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const container = stopResultsRef.current;
      if (container) {
        const first = container.querySelector<HTMLElement>("button");
        first?.focus();
      }
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (suggestions[0]) selectSuggestion(suggestions[0]);
      else dismissKeyboard();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePicker();
    }
  };

  const handleStopResultsKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const container = stopResultsRef.current;
    if (!container) return;
    const buttons = Array.from(container.querySelectorAll<HTMLElement>("button"));
    if (buttons.length === 0) return;
    const idx = buttons.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      buttons[idx < buttons.length - 1 ? idx + 1 : 0]?.focus();
    } else {
      buttons[idx > 0 ? idx - 1 : buttons.length - 1]?.focus();
    }
  }, []);

  function handleItinerarySelect(itinerary: Itinerary) {
    tripStart.request(itinerary);
  }

  function handleSwap() {
    // Swap origin and destination text/endpoints.
    const prevFromText = fromText;
    const prevFromEp = fromEndpoint;
    const prevToText = toText;
    const prevToEp = toEndpoint;
    setFromText(prevToText || null);
    setFromEndpoint(prevToEp);
    fromTouchedRef.current = !!prevToText;
    // GPS uses null text in From; carry its display label to To rather than
    // turning a selected endpoint into an apparently empty destination.
    setToText(prevFromText ?? (prevFromEp ? t("search.my_location", "My location") : ""));
    setToEndpoint(prevFromEp);
    setItineraries([]);
    setActiveField(null);
  }

  function focusField(field: "from" | "to") {
    openField(field);
    // The From field renders as an input (not the live-GPS pill) whenever it
    // has no endpoint, which is the only case this is reachable from.
    const input = field === "from" ? fromInputRef.current : toInputRef.current;
    input?.focus();
  }

  // A trip needs both ends before RouteResults can say anything true. Until
  // then its empty state reads "No routes found", which blames the search for
  // a form the user hasn't finished — so the half-filled form gets its own
  // surface. `to` is asked for first: it is the field the page opens on.
  const missingEndpoint: "from" | "to" | null = !toEndpoint
    ? "to"
    : !fromEndpoint
      ? "from"
      : null;

  // Treat "fromText === null with a GPS mappoint endpoint" as the live-GPS state.
  const fromUsesGps = fromText === null && fromEndpoint?.kind === "mappoint";
  const fromIsLiveGps = activeField !== "from" && fromUsesGps;
  const singleFieldPicker = activeFieldOnly && activeField !== null;
  const switchFieldLabel = activeField === "from"
    ? `${t("search.edit_destination", "Edit destination")}: ${toText || t("search.to", "Where to?")}`
    : `${t("search.edit_origin", "Edit origin")}: ${fromUsesGps ? t("search.my_location", "My location") : fromText || t("search.from", "From")}`;

  if (mapPickerField) return <ErrorBoundary context="search-map-picker" fallback={<div className="p-4 bg-surface h-full">
    <p role="alert">{t("search.map_failed", "Could not open the map. You can still search for a place.")}</p>
    <button type="button" className="min-h-11 text-accent" onClick={cancelMapPicker}>{t("search.map_cancel", "Cancel")}</button>
  </div>}><Suspense fallback={<div className="h-full flex flex-col gap-3 p-4 bg-surface">
    <p role="status">{t("search.map_loading", "Loading map…")}</p>
    <button type="button" className="min-h-11 text-accent" onClick={cancelMapPicker}>{t("search.map_cancel", "Cancel")}</button>
  </div>}>
    <SearchMapPicker field={mapPickerField} center={(mapPickerField === "from" ? fromEndpoint : toEndpoint) ?? undefined}
      onSelect={selectMapPoint} onCancel={cancelMapPicker} />
  </Suspense></ErrorBoundary>;

  const normalResults = (
    <>
      <RoutingModeIndicator />
      <RoutingFallbackNotice signal={routingFallback} />
      <RouteResults
        itineraries={itineraries}
        onSelect={handleItinerarySelect}
        loading={loading}
        error={searchError}
        engineError={engineError}
        engineFailureKind={engineFailureKind}
        remoteSearch={remoteSearch}
        emptyRemoteSearch={emptyRemoteSearch}
        serverEmpty={serverEmpty}
        onEarlier={handleEarlier}
        onLater={handleLater}
        origin={fromEndpoint}
        destination={toEndpoint}
        feedTz={feedTz}
        transitous={transitousProps}
      />
    </>
  );

  return (
    <div className="h-full min-h-0 flex flex-col bg-surface search-picker" data-active-field={activeField ?? undefined} data-single-field={activeFieldOnly || undefined}>
      {/* Search header — stacked from/to inputs with vertical swap button */}
      <div className="bg-surface-raised p-4 shadow-sm space-y-3">
        <div className="flex items-start gap-2">
          <button
            onClick={() => activeField ? closePicker() : navigate(-1)}
            className="p-2 rounded-full hover:bg-surface-overlay mt-1"
            aria-label={t("search.back", "Back")}
          >
            <svg
              className="w-5 h-5 text-fg-secondary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>

          <div className="flex-1 flex items-stretch gap-2">
            <div className="flex-1 space-y-2 search-picker-fields">
              {/* From field — live GPS pill when empty; text input when typing */}
              {fromIsLiveGps ? (
                <button
                  type="button"
                  onClick={() => openField("from")}
                  data-search-field="from"
                  className="group w-full flex items-center gap-2 px-3 py-2.5 text-sm rounded-lg
                    bg-input-bg border border-divider text-left
                    hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="inline-flex shrink-0 items-center justify-center w-5 h-5 text-accent" aria-hidden="true">
                    <LocationTargetIcon />
                  </span>
                  <span className="flex-1 min-w-0 truncate text-fg font-medium">
                    {t("search.my_location", "My location")}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-overlay px-2 py-1 text-xs font-medium text-fg-secondary transition-colors group-hover:text-accent">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                      <path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" />
                    </svg>
                    {t("search.change_location", "Change")}
                  </span>
                </button>
              ) : (
                <input
                  ref={fromInputRef}
                  data-search-field="from"
                  aria-label={t("search.from", "From")}
                  enterKeyHint="search"
                  type="text"
                  role="searchbox"
                  value={fromText ?? ""}
                  onChange={(e) => handleSearch(e.target.value, "from")}
                  onFocus={() => setActiveField("from")}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={fromUsesGps ? t("search.change_origin_placeholder", "Search another starting point") : t("search.from", "From")}
                  className="w-full px-3 py-2.5 text-sm rounded-lg border border-divider
                    bg-input-bg text-fg
                    focus:outline-none focus:ring-2 focus:ring-accent"
                />
              )}

              {/* To field */}
              <input
                ref={toInputRef}
                data-search-field="to"
                aria-label={t("search.to", "Where to?")}
                enterKeyHint="search"
                type="text"
                role="searchbox"
                value={toText}
                onChange={(e) => handleSearch(e.target.value, "to")}
                onFocus={() => setActiveField("to")}
                onKeyDown={handleSearchKeyDown}
                placeholder={t("search.to", "Where to?")}
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-divider
                  bg-input-bg text-fg
                  focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>

            <button
              type="button"
              onClick={() => singleFieldPicker ? openField(activeField === "from" ? "to" : "from") : handleSwap()}
              aria-label={singleFieldPicker ? switchFieldLabel : t("search.swap", "Swap origin and destination")}
              title={singleFieldPicker ? switchFieldLabel : t("search.swap", "Swap origin and destination")}
              className="w-11 min-h-11 shrink-0 flex flex-col gap-1 items-center justify-center rounded-lg border border-divider
                bg-input-bg text-fg-secondary hover:border-accent hover:text-accent
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {singleFieldPicker ? <>
                <span className="text-xs font-semibold">{activeField === "from" ? t("search.to_field", "To") : t("search.from", "From")}</span>
                <span aria-hidden="true" className="text-sm">⇄</span>
              </> : <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 4v16M7 4l-3 3M7 4l3 3" />
                <path d="M17 20V4M17 20l-3-3M17 20l3-3" />
              </svg>}
            </button>
          </div>
        </div>

        {/* Opt-in Arrive-by choice; null in the default build. */}
        {!activeField && ArriveByToolbar && (
          <ArriveByToolbar
            origin={fromEndpoint}
            destination={toEndpoint}
            recommended={itineraries}
            recommendedInitial={paginationTime === null}
          />
        )}

        {/* Route-only controls return after place picking. */}
        {!activeField && (availableModes.length >= 2 || availableRouteGroups.length >= 2) && (
          <div
            className="flex gap-1.5 overflow-x-auto pt-1 pb-0.5"
            role="group"
            aria-label={t("search.filter_modes", "Filter by vehicle type")}
          >
            {availableModes.flatMap((mode) => {
              const children = availableRouteGroups.filter((g) => g.parentMode === mode);
              if (children.length > 0) return children.map((group: RouteGroup) => {
                const isExcluded = excludedModes.includes(mode) || (excludedRouteGroupsByCity[cityId] ?? []).includes(group.id);
                return <button key={`group-${group.id}`} data-testid={`route-group-${group.id}`}
                  onClick={() => toggleRouteGroup(cityId, group, cityRouteGroups ?? [])}
                  aria-pressed={!isExcluded}
                  className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border shrink-0 transition-colors ${isExcluded
                    ? "border-divider bg-surface text-fg-muted line-through opacity-50" : "border-accent/30 bg-accent/10 text-fg"}`}>
                  <TransportModeIcon mode={mode} size="sm" />
                  <span>{t(group.labelKey, group.label)}</span>
                </button>;
              });
              const isExcluded = excludedModes.includes(mode);
              const config = MODE_CONFIG[mode];
              return (
                <button
                  key={mode}
                  onClick={() => toggleMode(mode)}
                  aria-pressed={!isExcluded}
                  className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium
                    border shrink-0 transition-colors
                    ${isExcluded
                      ? "border-divider bg-surface text-fg-muted line-through opacity-50"
                      : "border-accent/30 bg-accent/10 text-fg"
                    }`}
                  title={t(`settings.mode_${mode.toLowerCase()}`, config.label)}
                >
                  <TransportModeIcon mode={mode} size="sm" />
                  <span>{t(`settings.mode_${mode.toLowerCase()}`, config.label)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {hasRouteRestrictions && routingMode === "remote-primary" && <p className="px-3 py-1 text-xs text-fg-muted">
        {t("search.vehicle_filter_local", "Use on-device planning for bus and minibus filters.")}
      </p>}

      {/* Sort chips — pill-style, horizontally scrollable */}
      {!activeField && <div
        className="flex gap-2 px-3 py-2 overflow-x-auto bg-surface-raised border-b border-divider"
        role="tablist"
        aria-label={t("search.sort", "Sort")}
      >
        {(["fastest", "fewest_transfers", "least_walking"] as const).map((r) => {
          const active = ranking === r;
          return (
            <button
              key={r}
              role="tab"
              aria-selected={active}
              onClick={() => setRanking(r)}
              className={`shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-colors
                ${
                  active
                    ? "bg-accent text-badge-text"
                    : "bg-surface border border-divider text-fg-muted hover:border-accent"
                }`}
            >
              {r === "fastest"
                ? t("search.fastest", "Fastest")
                : r === "fewest_transfers"
                  ? t("search.fewest_transfers", "Fewest transfers")
                  : t("search.least_walking", "Least walking")}
            </button>
          );
        })}
      </div>}

      {/* Search results or route results */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        onTouchMove={() => { if (activeField && dismissOnScroll) dismissKeyboard(); }}
        onWheel={() => { if (activeField && dismissOnScroll) dismissKeyboard(); }}
      >
        {activeField ? (
          <div>
            <div className="flex min-h-11 items-center justify-between gap-2 px-3">
              <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 flex-1 py-1 text-[11px] leading-4 text-fg-muted">
              {suggestionStatus === "error" ? t("search.suggestions_error", "Could not search for places. Try again.")
                : suggestionStatus === "searching" ? t("search.searching", "Searching…")
                : suggestions.length > 0 ? t("search.suggestion_count", "{n} place suggestions").replace("{n}", String(suggestions.length))
                : activeQuery.trim() && suggestionStatus === "ready" ? t("search.no_place_suggestions", "No matching place suggestions")
                : <span className="sr-only">{t("search.type_place", "Type a stop, address or place")}</span>}
              </div>
              <SearchPlaceActions onMap={chooseOnMap} onLocation={useCurrentLocation} locationAvailable={gpsMode !== "disabled"} />
            </div>
            {suggestions.length > 0 && (
              <div
                ref={stopResultsRef}
                role="listbox"
                aria-label={t("search.results", "Search results")}
                className="bg-surface-raised"
                onKeyDown={handleStopResultsKeyDown}
              >
                {suggestions.slice(0, visibleSuggestionCount).map((suggestion) => {
                  const key =
                    suggestion.kind === "stop" ? `stop:${suggestion.stopId}` :
                    suggestion.kind === "stopGroup" ? `group:${suggestion.groupId}` :
                    `poi:${suggestion.label}:${suggestion.category}:${suggestion.lat}:${suggestion.lon}`;
                  const icon =
                    suggestion.kind === "stop" ? "\u{1F68F}" :
                    suggestion.kind === "stopGroup" ? "\u{1F68F}" :
                    poiCategoryIcon(suggestion.category);
                  const label =
                    suggestion.kind === "geocoded" ? suggestion.label :
                    suggestion.name;
                  const context = searchResultSubtext(suggestion, locale);
                  const defaultSubtitle = (
                    suggestion.kind === "stopGroup"
                      ? pluralize(
                          locale,
                          suggestion.stopCount,
                          t("search.stop_count_one", "{n} stop"),
                          t("search.stop_count_few", "{n} stops"),
                          t("search.stop_count_many", "{n} stops"),
                        ).replace("{n}", String(suggestion.stopCount))
                      : suggestion.kind === "geocoded" && suggestion.source === "osm"
                        ? t("search.poi_badge", "POI")
                        : suggestion.kind === "geocoded"
                          ? t("search.landmark_badge", "Landmark")
                          : undefined);
                  const subtitle = context && suggestion.kind === "stopGroup"
                    ? `${context} · ${defaultSubtitle}`
                    : context ?? defaultSubtitle;

                  return (
                    <button
                      key={key}
                      role="option"
                      aria-selected={false}
                      onClick={() => selectSuggestion(suggestion)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") selectSuggestion(suggestion);
                      }}
                      className={`w-full min-h-11 text-left px-4 ${compactRows ? "py-2" : "py-3"} border-b border-divider
                        hover:bg-surface-overlay focus:bg-surface-overlay focus:outline-none
                        focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent flex items-center gap-3`}
                    >
                      <span className="text-fg-muted text-lg shrink-0" aria-hidden="true">{icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="text-sm text-fg block truncate">{label}</span>
                        {/* Badge and subtitle are separate words, not one run —
                            they need a gap or they read as "RECENTPOI". */}
                        {(subtitle ||
                          (suggestion.kind !== "stopGroup" && suggestion.recent)) && (
                          <span className="flex min-w-0 items-center gap-1.5">
                            {suggestion.kind !== "stopGroup" && suggestion.recent && (
                              <span
                                data-testid="recent-badge"
                                className="inline-flex shrink-0 items-center text-[10px] text-fg-muted font-medium uppercase tracking-wide"
                              >
                                {t("search.recent_badge", "Recent")}
                              </span>
                            )}
                            {subtitle && (
                              <span className="text-xs text-fg-muted truncate" title={subtitle}>{subtitle}</span>
                            )}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {suggestions.length > visibleSuggestionCount && (
              <button
                type="button"
                data-testid="search-show-more"
                onClick={() => setVisibleSuggestionCount((n) => n + SUGGESTION_PAGE_SIZE)}
                className="w-full px-4 py-3 text-sm font-medium text-accent
                  hover:bg-surface-overlay focus:bg-surface-overlay focus:outline-none"
              >
                {t("search.show_more", "Show more")}
              </button>
            )}
            <PinnedSavesSection onSelect={selectSave} query={activeQuery} compact={compactRows} />
            {!activeQuery.trim() && <>
            <OptionalStorageChoice
              category="recents"
              presentation="contextual"
              title={t("privacy.optional.recents_prompt", "Remember recent places?")}
              description={t(
                "privacy.optional.recents_prompt_desc",
                "This can make repeat trips quicker. PTN works normally if you say no, and the choice applies only to this browser.",
              )}
            />
            </>}
          </div>
        ) : missingEndpoint ? (
          <TripIncompleteNotice
            missing={missingEndpoint}
            // Geolocation is still resolving, so the From field is about to
            // fill itself — don't ask the user for what's already coming.
            locating={missingEndpoint === "from" && locating}
            onPick={() => focusField(missingEndpoint)}
          />
        ) : ArriveByResults ? (
          // Opt-in build only: an applied arrive-by deadline replaces the list.
          <ArriveByResults origin={fromEndpoint} destination={toEndpoint} onSelect={handleItinerarySelect}>
            {normalResults}
          </ArriveByResults>
        ) : (
          normalResults
        )}
      </div>
      {tripStart.dialog}
    </div>
  );
}

interface TripIncompleteNoticeProps {
  missing: "from" | "to";
  locating: boolean;
  onPick: () => void;
}

/**
 * Shown in place of the results list while the trip is half-specified — e.g.
 * after a map long-press sets only the destination and the device has no
 * location fix. Names the field that is missing and focuses it on tap.
 */
function TripIncompleteNotice({
  missing,
  locating,
  onPick,
}: TripIncompleteNoticeProps) {
  const { t } = useTranslation();

  if (locating) {
    return (
      <div
        className="p-6 text-center text-fg-muted"
        data-testid="trip-incomplete"
      >
        {t("search.locating", "Finding your location\u2026")}
      </div>
    );
  }

  return (
    <div
      className="p-6 text-center text-fg-muted space-y-3"
      data-testid="trip-incomplete"
    >
      <p className="text-sm">
        {missing === "from"
          ? t("search.needs_origin", "Add a starting point to see routes.")
          : t("search.needs_destination", "Add a destination to see routes.")}
      </p>
      <button
        type="button"
        onClick={onPick}
        className="px-4 py-2 rounded-lg border border-divider text-sm text-fg
          hover:bg-surface-overlay focus-visible:outline-none
          focus-visible:ring-2 focus-visible:ring-accent"
      >
        {missing === "from"
          ? t("search.set_origin", "Choose starting point")
          : t("search.set_destination", "Choose destination")}
      </button>
    </div>
  );
}
