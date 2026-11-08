import {StopSourceCache, rememberStopSource, updateStopSource} from "./stopSource.ts";
import {StopViewportIndex} from "./stopViewportIndex.ts";
import {createPanCitySwitcher} from "./panCitySwitch.ts";
import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from "react";
import maplibregl from "../../map/maplibre.ts";
import { StopFade } from "./stopFade.ts";
import { LocateControl } from "./LocateControl.ts";
import { useTranslation } from "../../i18n/index.ts";
import { createRoot } from "react-dom/client";
import type { StopWithLines, LatLon, LabelAnchor } from "@pt/shared";
import {
  ZOOM_DOTS_MIN,
  ZOOM_OVERVIEW_MAX,
  ZOOM_LABELS_MIN,
  ZOOM_CARDS_MIN,
  VIEWPORT_BUFFER,
} from "@pt/shared/constants";
import { SCHEDULE_TILE_SIZE_LABEL } from "@pt/shared/poi";
import { prewarmPhase1, prewarmPhase2 } from "../../services/scheduleTilePrewarm.ts";
import { warmupBrotli } from "../../services/brotliDecode.ts";
import {
  StopMarker,
  STOP_CARD_BADGE_CLASS,
  STOP_CARD_BODY_CLASS,
  STOP_CARD_LINES_CLASS,
  STOP_CARD_NAME_CLASS,
  STOP_CARD_ROW_CLASS,
  splitBadgeRows,
} from "./StopMarker.tsx";
import { solveLabels, diffDimmed, translatePageRectToCanvas, type LabelDot, type ObstacleRect as PlacementObstacle } from "./cardPlacement.ts";
import { deriveStopHintsAsync, polylinesServingStop, type PatternPolyline, type StopHint } from "./cardBearing.ts";
import { projectGeoSideToScreen } from "./cardHintsScreen.ts";
import { hardHideLabelsEnabled } from "./hardHideFlag.ts";
import { installAttributionAutoHide } from "./attributionAutoHide.ts";
import { trackBottomControlInsets } from "./bottomControlInsets.ts";
import { trackSheetControlLift } from "./sheetControlLift.ts";
import { buildLinePatterns } from "../../utils/buildLinePatterns.ts";
import { decodePolyline } from "../../utils/polyline.ts";
import { captureCityData, useCityDataStore } from "../../services/cityData.ts";
import { resolveLabelOverlaps, type LabelItem } from "./labelOverlap.ts";
import { reportError } from "../../services/errorReporter.ts";
import { createStopMarkerElement, findMarkerStopId } from "./markerClickDelegation.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useMapTapStore } from "../../stores/mapTapStore.ts";
import { useMapObstaclesStore } from "../../stores/mapObstaclesStore.ts";
import { useMapViewportStore, quantizeViewportBounds } from "../../stores/mapViewportStore.ts";
import { findCityByLocation, getAvailableCities } from "../../config/cities.ts";
import { cityOverviewFeatures, IS_CITY, IS_STOP } from "./cityOverview.ts";
import { loadViewport, saveViewport } from "../../utils/mapViewport.ts";
import {
  BASEMAP_RETRY_ON_ONLINE,
  MAP_LABELS_MODE,
  resolveBasemapTimeoutMs,
} from "../../map/mapConfig.ts";
import {
  LOCAL_BG_LAYER_ID,
  buildLocalStyle,
  buildMergedCartoStyle,
  mergeCartoIntoRunningMap,
  labelFontstack,
  localGlyphRequest,
  type CartoStyleJson,
} from "../../map/styleBuilder.ts";
import { fetchBasemapStyle } from "../../services/basemapPrivacy.ts";
import { getPolicy, usePolicy } from "../../stores/privacyStore.ts";
import { useEffectiveMapMode } from "../../map/mapMode.ts";

interface TransitMapProps {
  center?: LatLon;
  zoom?: number;
  stops?: StopWithLines[];
  /** Full catalog geometry, independent of transient urban visibility/badges. */
  geometryStops?: StopWithLines[];
  onStopClick?: (stop: StopWithLines) => void;
  onMapClick?: (location: LatLon) => void;
  onGeolocate?: (position: LatLon) => void;
  /** Fired after the map's `load` event so overlays can safely add sources/layers. */
  onMapReady?: (map: maplibregl.Map) => void;
  /** When true, recenter once on load (flies to the user). */
  autoLocateOnLoad?: boolean;
  className?: string;
  /** Currently selected stop id, so the solver never hides it (Stage 1). */
  selectedStopId?: string;
}

function getDefaultCenter(): LatLon {
  return useCityStore.getState().activeCity.center;
}
const DEFAULT_ZOOM = 13;

const SOURCE_ID = "stops-source";
// The city markers keep the old cluster layer's id: bike, corridor, micromap
// and route-leg layers anchor below "stops-clusters" as the bottom stop layer.
const CITY_LAYER = "stops-clusters";
const CITY_LABEL_LAYER = "stops-city-label";
const DOT_LAYER = "stops-dot";
const LABEL_LAYER = "stops-label";

// Data-driven label placement from the backend solver's `labelAnchor` property.
// `labelAnchor` names the SIDE of the dot the label sits on; MapLibre's
// `text-anchor` names which part of the text is pinned to the point — the
// opposite side — so the two are inverted here. `text-offset` (em units, +y is
// down) then pushes the label clear of the dot. When `labelAnchor` is absent the
// `match` fallbacks reproduce the legacy below-the-dot placement.
const LABEL_OFFSET = 1.1; // em, straight directions
const LABEL_DIAG = 0.8; // em per axis, diagonal directions
/** Max visible labels the Phase-3 resolver will process per moveend. */
const LABEL_RESOLVE_MAX = 400;
const LABEL_TEXT_ANCHOR_EXPR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "labelAnchor"],
  "right", "left",
  "left", "right",
  "top", "bottom",
  "bottom", "top",
  "top-right", "bottom-left",
  "top-left", "bottom-right",
  "bottom-right", "top-left",
  "bottom-left", "top-right",
  "top", // fallback (legacy)
];
/** Lazily-created 2D context for measuring label text widths (Phase 3). */
let labelMeasureCtx: CanvasRenderingContext2D | null = null;
function measureLabelWidth(text: string): number {
  if (!labelMeasureCtx) {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return text.length * 7; // coarse fallback
    // Same size and face as the stop labels (labelFontstack).
    ctx.font = "11px \"Open Sans Variable\", \"Noto Sans Georgian Variable\", sans-serif";
    labelMeasureCtx = ctx;
  }
  return labelMeasureCtx.measureText(text).width;
}

const LABEL_TEXT_OFFSET_EXPR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "labelAnchor"],
  "right", ["literal", [LABEL_OFFSET, 0]],
  "left", ["literal", [-LABEL_OFFSET, 0]],
  "top", ["literal", [0, -LABEL_OFFSET]],
  "bottom", ["literal", [0, LABEL_OFFSET]],
  "top-right", ["literal", [LABEL_DIAG, -LABEL_DIAG]],
  "top-left", ["literal", [-LABEL_DIAG, -LABEL_DIAG]],
  "bottom-right", ["literal", [LABEL_DIAG, LABEL_DIAG]],
  "bottom-left", ["literal", [-LABEL_DIAG, LABEL_DIAG]],
  ["literal", [0, 1.5]], // fallback (legacy)
];

/** Debounce delay for marker management during zoom/pan (ms) */
const MARKER_DEBOUNCE_MS = 150;

// Stop-card hard-hide. Stage 1b flipped the DEFAULT to ON (hide-rather-than-
// overlap; Stage 2's road-aware placement means few cards hit it). Rollback
// ("switch back anytime"): localStorage `ptn.hardHideLabels="0"` (instant, per
// user) or env `VITE_PT_HARD_HIDE_LABELS="0"` (deploy-wide). See hardHideFlag.ts.
// The former theme-swap caveat (a brief un-dim flash when `map.setStyle` dropped
// the dimmed-dot feature-state) is FIXED in applyMapTheme below: it re-solves on
// the post-swap `idle` event, re-applying the feature-state.
const HARD_HIDE_LABELS = hardHideLabelsEnabled(
  typeof localStorage !== "undefined" ? localStorage : undefined,
  import.meta.env?.VITE_PT_HARD_HIDE_LABELS,
);

/** Padding added to measured card dimensions for collision clearance */
const MARKER_COLLISION_PAD = 6;
// VIEWPORT_BUFFER (render markers within 1.5x the viewport so they don't pop in
// during panning) is shared from @pt/shared so the urban-mode badge-activity
// sweep covers exactly the same buffer — see useViewportBadgeActivity.

/** Long-press threshold for map-tap gesture (ms) */
const LONG_PRESS_MS = 500;
/** Maximum pointer movement during a long-press before it's treated as a drag (px) */
const LONG_PRESS_MAX_MOVE_PX = 10;

function publishViewport(map: maplibregl.Map): void {
  const b = map.getBounds();
  // Snap to a coarse grid so sub-cell pans publish identical bounds — this is
  // what stops useViewportBadgeActivity from re-sweeping tiles on every nudge.
  // The snap slack stays inside the badge sweep's VIEWPORT_BUFFER, so coverage
  // is unaffected.
  useMapViewportStore.getState().setViewport(
    quantizeViewportBounds({ north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() }),
    map.getZoom(),
  );
}

interface AppliedBasemapResources {
  sourceIds: string[];
  layerIds: string[];
}

const NO_BASEMAP_RESOURCES: AppliedBasemapResources = {
  sourceIds: [],
  layerIds: [],
};

function collectNewBasemapResources(
  map: maplibregl.Map,
  style: CartoStyleJson,
): AppliedBasemapResources {
  return {
    sourceIds: Object.keys(style.sources ?? {}).filter(
      (id) => !map.getSource(id),
    ),
    layerIds: (style.layers ?? [])
      .map((layer) => layer.id)
      .filter((id) => !map.getLayer(id)),
  };
}

/** Remove only the resources introduced by the external basemap. Dynamic PTN
 * overlays (routes, selected stops, and user position) stay attached. */
function removeExternalBasemap(
  map: maplibregl.Map,
  resources: AppliedBasemapResources,
  isDark: boolean,
): void {
  for (const id of [...resources.layerIds].reverse()) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of resources.sourceIds) {
    if (map.getSource(id)) map.removeSource(id);
  }

  const localStyle = buildLocalStyle(isDark);
  const background = localStyle.layers[0];
  if (map.getLayer(LOCAL_BG_LAYER_ID)) {
    if (
      background.type === "background" &&
      background.paint?.["background-color"]
    ) {
      map.setPaintProperty(
        LOCAL_BG_LAYER_ID,
        "background-color",
        background.paint["background-color"],
      );
    }
  } else {
    const firstLayerId = map.getStyle().layers?.[0]?.id;
    map.addLayer(background, firstLayerId);
  }
  map.setSprite(null);
  map.setGlyphs(localStyle.glyphs);
}

export const TransitMap = forwardRef<maplibregl.Map | null, TransitMapProps>(
  function TransitMap(
    {
      center,
      zoom = DEFAULT_ZOOM,
      stops = [],
      geometryStops,
      onStopClick,
      onMapClick,
      onGeolocate,
      onMapReady,
      autoLocateOnLoad = false,
      className = "",
      selectedStopId,
    },
    ref
  ) {
    const { t } = useTranslation();
    const translateRef = useRef(t);
    translateRef.current = t;
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const onMapClickRef = useRef(onMapClick);
    const onStopClickRef = useRef(onStopClick);
    const onGeolocateRef = useRef(onGeolocate);
    const onMapReadyRef = useRef(onMapReady);
    const autoLocateOnLoadRef = useRef(autoLocateOnLoad);
    const stopsRef = useRef(stops);
    const stopSourceCache = useMemo(() => new StopSourceCache(), []);
    const stopFadeRef = useRef<StopFade | null>(null);
    const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
    const markerRootsRef = useRef<Map<string, ReturnType<typeof createRoot>>>(
      new Map()
    );
    const geolocateRef = useRef<LocateControl | null>(null);
    const placementFrameRef = useRef<number | null>(null);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const measureCacheRef = useRef<Map<string, { w: number; h: number }>>(new Map());
    // Phase 3 overlap resolver: stopId → anchor override (only entries that
    // differ from the solver anchor; absent ⇒ use the solver anchor). Rebuilt on
    // moveend while the label layer is the active representation.
    const labelOverrideRef = useRef<Map<string, LabelAnchor>>(new Map());
    const labelResolveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const selectedStopIdRef = useRef<string | undefined>(undefined);
    selectedStopIdRef.current = selectedStopId;
    const prevOffsetsRef = useRef<Map<string, { dx: number; dy: number }>>(new Map());
    const dimmedIdsRef = useRef<Set<string>>(new Set());
    // Stage 2: per-stop curb-side hints in the GEOGRAPHIC
    // frame. These are constants of the stop+shape geometry, derived ONCE per
    // city/stop-set (the async preload effect below), NOT recomputed per
    // solve/pan/zoom. Empty until the preload resolves → placement stays Stage-1
    // (no `side` threaded) until hints arrive. The preload re-keys (and
    // clears this) whenever the city or the stop-set identity changes.
    const hintsByStopIdRef = useRef<Map<string, StopHint>>(new Map());

    // Stable geometry identity for the stop set. Include every input used by
    // hint derivation, but sort stops/routes so fresh equivalent arrays do not
    // trigger a reload. Pan/zoom never changes this key.
    const hintStops = geometryStops ?? stops;
    const hintIndex = useGtfsDataStore((s) => s.raptorIndex);
    const hintCityId = useGtfsDataStore((s) => s.loadedCityId);
    const cityDataRevision = useCityDataStore(state => state.revision);
    const stopSetKey = useMemo(
      () =>
        hintStops
          .map((s) =>
            `${s.id}:${s.name}:${s.location.lat}:${s.location.lon}:${s.parentStationId ?? ""}:` +
            (s.lines ?? []).map((l) => l.routeId).sort().join("|"),
          )
          .sort()
          .join(","),
      [hintStops],
    );
    const [mapReady, setMapReady] = useState(false);
    const theme = useSettingsStore((s) => s.theme);
    // Any mode other than `detailed` draws locally and never touches the
    // external basemap — see map/mapMode.ts for the single choice behind it.
    const localMapOnly = useEffectiveMapMode() !== "detailed";
    const basemapMode = usePolicy().basemapMode;
    const activeCity = useCityStore((s) => s.activeCity);
    const fadeGeneration = useCityDataStore(state => state.active?.token.cityId === activeCity.id
      ? state.active.token.generationId : null);
    const fadeContext = useMemo(() => ({ cityId: activeCity.id, generation: fadeGeneration }), [activeCity.id, fadeGeneration]);
    const viewportIndex = useMemo(() => new StopViewportIndex(hintStops), [hintStops, fadeContext]);
    const activeStopsById = useMemo(() => new Map(stops.map(stop => [stop.id, stop])), [stops]);
    const viewportDataRef = useRef({index: viewportIndex, active: activeStopsById});
    const currentMapThemeRef = useRef<"light" | "dark" | null>(null);
    const lastFlownCityRef = useRef<string>(activeCity.id);
    const hasFlownToLocationRef = useRef(false);
    const cartoStateRef = useRef<{
      status: "idle" | "loading" | "loaded" | "failed";
      abortCtrl: AbortController | null;
    }>({ status: "idle", abortCtrl: null });
    // Track what is actually installed in MapLibre separately from fetch
    // state. A theme swap changes status to "loading" while the old external
    // style is still live; privacy tightening must remove that style too.
    const cartoAppliedRef = useRef(false);
    const cartoResourcesRef = useRef<AppliedBasemapResources>(
      NO_BASEMAP_RESOURCES,
    );
    const loadCartoRef = useRef<(() => Promise<void>) | null>(null);
    const [glyphsReady, setGlyphsReady] = useState(MAP_LABELS_MODE === "inline");
    const localMapOnlyRef = useRef(localMapOnly);

    // Expose map instance via forwarded ref
    useImperativeHandle(ref, () => mapRef.current!, [mapReady]);

    // Keep refs in sync with latest values
    useEffect(() => {
      onMapClickRef.current = onMapClick;
      onStopClickRef.current = onStopClick;
      onGeolocateRef.current = onGeolocate;
      onMapReadyRef.current = onMapReady;
      autoLocateOnLoadRef.current = autoLocateOnLoad;
      stopsRef.current = stops;
      viewportDataRef.current = {index: viewportIndex, active: activeStopsById};
    });

    useEffect(() => {
      localMapOnlyRef.current = localMapOnly;
    }, [localMapOnly]);

    // Build GeoJSON from stops
    const buildGeoJSON = useCallback(
      (stopsData: StopWithLines[]): GeoJSON.FeatureCollection<GeoJSON.Point> => {
        const activeIds = new Set(stopsData.map(stop => stop.id));
        const exits = [...(stopFadeRef.current?.exiting.values() ?? [])]
          .filter(({ stop }) => !activeIds.has(stop.id)).map(({ stop }) => stop);
        return stopSourceCache.build(stopsData, exits, cityOverviewFeatures(getAvailableCities()), labelOverrideRef.current);
      },
      [stopSourceCache]
    );

    // Remove all station card markers
    const removeAllMarkers = useCallback(() => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current.clear();
      // Markers are detached immediately. Dispose their independent React
      // roots after the parent commit, rather than unmounting a root while
      // React is still flushing this component's effects.
      markerRootsRef.current.forEach((root) => queueMicrotask(() => root.unmount()));
      markerRootsRef.current.clear();
    }, []);

    // Update station card markers based on current viewport and zoom
    const resolveMarkers = useCallback(() => {
      const map = mapRef.current;
      if (!map) return;
      publishViewport(map);

      const currentZoom = map.getZoom();

      if (currentZoom < ZOOM_CARDS_MIN) {
        if (markersRef.current.size > 0) {
          removeAllMarkers();
        }
        prevOffsetsRef.current = new Map();
        dimmedIdsRef.current = new Set();
        return;
      }

      const bounds = map.getBounds();
      const viewport = viewportDataRef.current;

      // Expand bounds by VIEWPORT_BUFFER so markers are pre-rendered beyond
      // the visible area and don't pop in during panning.
      const lngSpan = bounds.getEast() - bounds.getWest();
      const latSpan = bounds.getNorth() - bounds.getSouth();
      const buffered = new maplibregl.LngLatBounds(
        [bounds.getWest() - lngSpan * VIEWPORT_BUFFER, bounds.getSouth() - latSpan * VIEWPORT_BUFFER],
        [bounds.getEast() + lngSpan * VIEWPORT_BUFFER, bounds.getNorth() + latSpan * VIEWPORT_BUFFER],
      );

      // Find stops visible in the buffered viewport
      const visibleStops = viewport.index.query({west: buffered.getWest(), east: buffered.getEast(),
        south: buffered.getSouth(), north: buffered.getNorth()}).flatMap(id => {
          const stop = viewport.active.get(id);
          return stop ? [stop] : [];
        });

      // Project stops to pixel coordinates and sort by line count (more lines = higher priority)
      const projected = visibleStops
        .map((stop) => ({
          stop,
          px: map.project([stop.location.lon, stop.location.lat]),
          lineCount: stop.lines?.length ?? 0,
        }))
        .sort((a, b) => b.lineCount - a.lineCount);

      // Measure card dimensions — cached per stop ID + actual line names so
      // that urban-mode toggles or periodic refreshes that change visible
      // routes trigger a re-measure. All uncached cards are batched into one
      // hidden container for a single reflow.
      const cache = measureCacheRef.current;
      const cacheKey = (stop: StopWithLines) =>
        `${stop.id}_${stop.name}_${stop.lines?.map((l) => l.shortName).join(",") ?? ""}`;
      const uncached = projected.filter(({ stop }) => !cache.has(cacheKey(stop)));

      if (uncached.length > 0) {
        const measureContainer = document.createElement("div");
        measureContainer.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;top:-9999px;left:-9999px";
        document.body.appendChild(measureContainer);

        const cards: { id: string; el: HTMLElement }[] = [];
        for (const { stop } of uncached) {
          const card = document.createElement("div");
          card.className = STOP_CARD_BODY_CLASS;
          const nameEl = document.createElement("div");
          nameEl.className = STOP_CARD_NAME_CLASS;
          nameEl.textContent = stop.name;
          card.appendChild(nameEl);
          if (stop.lines && stop.lines.length > 0) {
            const container = document.createElement("div");
            container.className = STOP_CARD_LINES_CLASS;
            for (const row of splitBadgeRows(stop.lines)) {
              const rowEl = document.createElement("div");
              rowEl.className = STOP_CARD_ROW_CLASS;
              for (const line of row) {
                const badge = document.createElement("span");
                badge.className = STOP_CARD_BADGE_CLASS;
                badge.textContent = line.shortName;
                rowEl.appendChild(badge);
              }
              container.appendChild(rowEl);
            }
            card.appendChild(container);
          }
          measureContainer.appendChild(card);
          cards.push({ id: cacheKey(stop), el: card });
        }

        // Single reflow — read all measurements at once
        for (const { id, el } of cards) {
          const rect = el.getBoundingClientRect();
          cache.set(id, {
            w: Math.ceil(rect.width) + MARKER_COLLISION_PAD,
            h: Math.ceil(rect.height) + MARKER_COLLISION_PAD,
          });
        }
        measureContainer.remove();
      }

      const measuredSizes = cache;

      const canvas = map.getCanvas();

      // UI-overlay obstacles (search bar, FavoritesBar, StepList, popups, …).
      // Stored in page-space; translate to canvas-relative pixels here so the
      // placement algorithm can compare with map.project(...) coordinates.
      const canvasRect = canvas.getBoundingClientRect();
      const overlayObstacles: PlacementObstacle[] = [];
      for (const rect of useMapObstaclesStore.getState().obstacles.values()) {
        overlayObstacles.push(translatePageRectToCanvas(rect, canvasRect));
      }

      // Batch solve: one call owns ordering, hysteresis, hard-hide, metrics.
      // Stage 2: attach each SCREEN-space curb side when present. Hints are
      // geographic constants from the preload ref; `projectGeoSideToScreen`
      // runs them through the live MapLibre transform so bearing/pitch are
      // honored. A stop with no hint (or a null `side`) stays
      // Stage-1 — the optional fields are simply omitted, which the solver reads
      // as the legacy behavior.
      const hints = hintsByStopIdRef.current;
      const labelDots: LabelDot[] = projected.map(({ stop, px }) => {
        const size = measuredSizes.get(cacheKey(stop)) ?? { w: 100, h: 40 };
        const dot: LabelDot = {
          id: stop.id,
          x: px.x,
          y: px.y,
          w: size.w,
          h: size.h,
          lineCount: stop.lines?.length ?? 0,
          onscreen: px.x >= 0 && px.x <= canvas.clientWidth && px.y >= 0 && px.y <= canvas.clientHeight,
        };
        const hint = hints.get(stop.id);
        if (hint) {
          const screenSide = projectGeoSideToScreen(
            stop.location,
            hint.side,
            (point) => map.project([point.lon, point.lat]),
          );
          if (screenSide) {
            dot.side = screenSide;
            // A non-null side means every shape serving this physical stop has
            // an unambiguous travel orientation (or it is a true two-platform
            // pair). Keep the card on that curb whenever a clean slot exists.
            dot.pinToSide = true;
          }
        }
        return dot;
      });

      const { offsets: winnerOffsets, hidden, metrics } = solveLabels({
        dots: labelDots,
        obstacles: overlayObstacles,
        viewport: { w: canvas.clientWidth, h: canvas.clientHeight },
        prev: prevOffsetsRef.current,
        selectedId: selectedStopIdRef.current,
        hardHide: HARD_HIDE_LABELS,
      });

      // Carry offsets forward for next solve's hysteresis (winners only).
      prevOffsetsRef.current = winnerOffsets;

      // Aggregate give-up telemetry: replaces the old per-stop last-resort error.
      if (winnerOffsets.size === 0 && labelDots.length > 0) {
        reportError(new Error("[cardPlacement] solver placed zero labels"), {
          context: { where: "solveLabels.allHidden", dots: labelDots.length, hidden: hidden.size },
        });
      }
      if (import.meta.env?.DEV) {
        console.debug("[cardPlacement] metrics", metrics);
      }

      const winnersById = new Set(winnerOffsets.keys());

      // Remove markers that are no longer winners or left viewport
      markersRef.current.forEach((marker, id) => {
        if (!winnersById.has(id) && !stopFadeRef.current?.exiting.has(id)) {
          marker.remove();
          markersRef.current.delete(id);
          const root = markerRootsRef.current.get(id);
          if (root) {
            queueMicrotask(() => root.unmount());
            markerRootsRef.current.delete(id);
          }
        }
      });

      // Create or update markers — always re-render with fresh offsets
      // so cards reposition dynamically on zoom/pan
      for (const { stop } of projected) {
        const offset = winnerOffsets.get(stop.id);
        if (!offset) continue;

        const existingRoot = markerRootsRef.current.get(stop.id);
        if (existingRoot) {
          // Re-render existing marker with updated offset
          existingRoot.render(
            <StopMarker
              name={stop.name}
              lines={stop.lines}
              offset={offset}
            />
          );
          continue;
        }

        // Outer marker element — click handling is delegated on the map's
        // canvas container (see init useEffect), so this factory MUST NOT
        // attach a per-element listener (it would vanish when
        // `marker.remove()` detaches `el` mid-pan).
        const el = createStopMarkerElement(stop.id);

        const root = createRoot(el);
        root.render(
          <StopMarker
            name={stop.name}
            lines={stop.lines}
            offset={offset}
          />
        );

        const marker = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([stop.location.lon, stop.location.lat])
          .addTo(map);

        markersRef.current.set(stop.id, marker);
        markerRootsRef.current.set(stop.id, root);
      }

      // Dimmed-dot diff. Only advance `dimmedIdsRef` once the feature-state was
      // actually applied — if the source isn't ready yet (init race), keep the
      // tracked set unchanged so the next solve re-emits the pending dims rather
      // than treating them as already applied (which would leave a hidden dot
      // un-dimmed once the source appears).
      const presentationHidden = new Set(hidden);
      for (const id of dimmedIdsRef.current) {
        if (stopFadeRef.current?.exiting.has(id)) presentationHidden.add(id);
      }
      const { toSet, toClear } = diffDimmed(dimmedIdsRef.current, presentationHidden);
      const src = map.getSource(SOURCE_ID);
      if (src) {
        for (const id of toClear) map.removeFeatureState({ source: SOURCE_ID, id }, "hidden");
        for (const id of toSet) map.setFeatureState({ source: SOURCE_ID, id }, { hidden: true });
        dimmedIdsRef.current = presentationHidden;
      }
    }, [removeAllMarkers]);

    // Data, geometry and selection can change in the same React commit.
    // Resolve once at the next paint using the latest committed refs.
    const updateMarkers = useCallback(() => {
      if (placementFrameRef.current !== null) return;
      placementFrameRef.current = requestAnimationFrame(() => {
        placementFrameRef.current = null;
        resolveMarkers();
      });
    }, [resolveMarkers]);

    useEffect(() => {
      if (mapReady) updateMarkers();
    }, [selectedStopId, mapReady, updateMarkers]);

    // Debounced marker update
    const debouncedUpdateMarkers = useCallback(() => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        updateMarkers();
        debounceTimerRef.current = null;
      }, MARKER_DEBOUNCE_MS);
    }, [updateMarkers]);

    // Phase 3: re-resolve label anchors for currently-visible labels in SCREEN
    // space so anchored labels that still collide at this zoom rotate to a free
    // direction instead of being culled by MapLibre. Only active in the label
    // zoom band ([ZOOM_LABELS_MIN, ZOOM_CARDS_MIN)); clears overrides on exit.
    const resolveVisibleLabels = useCallback(() => {
      const map = mapRef.current;
      if (!map) return;
      const source = map.getSource(SOURCE_ID) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (!source) return;

      const overrides = labelOverrideRef.current;
      const zoom = map.getZoom();
      const inBand = zoom >= ZOOM_LABELS_MIN && zoom < ZOOM_CARDS_MIN;

      if (!inBand) {
        // Symbol labels are hidden outside the band; drop overrides once so a
        // later re-entry recomputes fresh against solver anchors.
        if (overrides.size > 0) {
          labelOverrideRef.current = new Map();
          updateStopSource(source, buildGeoJSON(stopsRef.current));
        }
        return;
      }

      const bounds = map.getBounds();
      const items: LabelItem[] = [];
      const ids: string[] = [];
      const viewport = viewportDataRef.current;
      for (const id of viewport.index.query({west: bounds.getWest(), east: bounds.getEast(),
        south: bounds.getSouth(), north: bounds.getNorth()})) {
        const stop = viewport.active.get(id);
        if (!stop) continue;
        const px = map.project([stop.location.lon, stop.location.lat]);
        items.push({
          x: px.x,
          y: px.y,
          width: measureLabelWidth(stop.name),
          // "bottom" mirrors the legacy null-anchor render (text-anchor "top").
          anchor: stop.labelAnchor ?? "bottom",
        });
        ids.push(stop.id);
      }

      // Bound the O(passes·n²) resolver — above the cap, lean on solver anchors
      // + MapLibre's own collision rather than risk moveend jank.
      if (items.length > LABEL_RESOLVE_MAX) {
        if (overrides.size > 0) {
          labelOverrideRef.current = new Map();
          updateStopSource(source, buildGeoJSON(stopsRef.current));
        }
        return;
      }

      const resolved = resolveLabelOverlaps(items);

      // Keep only anchors that differ from the solver's (small, self-cleaning).
      const next = new Map<string, LabelAnchor>();
      for (let i = 0; i < ids.length; i++) {
        if (resolved[i] !== items[i].anchor) next.set(ids[i], resolved[i]);
      }

      // Skip the setData churn when the override set is unchanged.
      let same = next.size === overrides.size;
      if (same) {
        for (const [id, a] of next) {
          if (overrides.get(id) !== a) {
            same = false;
            break;
          }
        }
      }
      if (same) return;

      labelOverrideRef.current = next;
      updateStopSource(source, buildGeoJSON(stopsRef.current));
    }, [buildGeoJSON]);

    const debouncedResolveLabels = useCallback(() => {
      if (labelResolveTimerRef.current) clearTimeout(labelResolveTimerRef.current);
      labelResolveTimerRef.current = setTimeout(() => {
        resolveVisibleLabels();
        labelResolveTimerRef.current = null;
      }, MARKER_DEBOUNCE_MS);
    }, [resolveVisibleLabels]);

    useEffect(() => {
      if (!mapReady || !document.fonts) return;
      let cancelled = false;
      const invalidateMeasurements = () => {
        if (cancelled) return;
        measureCacheRef.current.clear();
        updateMarkers();
        debouncedResolveLabels();
      };
      document.fonts.addEventListener("loadingdone", invalidateMeasurements);
      return () => {
        cancelled = true;
        document.fonts.removeEventListener("loadingdone", invalidateMeasurements);
      };
    }, [mapReady, updateMarkers, debouncedResolveLabels]);

    // Re-place markers whenever the registered set of UI-overlay obstacles
    // changes (e.g. StepList opens, popup mounts, sheet height transitions).
    // The store builds a new Map on real mutations and short-circuits no-ops,
    // so a Map identity change is a sufficient "something moved" signal.
    useEffect(() => {
      if (!mapReady) return;
      const unsubscribe = useMapObstaclesStore.subscribe((state, prev) => {
        if (state.obstacles !== prev.obstacles) {
          debouncedUpdateMarkers();
        }
      });
      return unsubscribe;
    }, [mapReady, debouncedUpdateMarkers]);

    // Phase 1 prewarm: fire once after the map is ready, during idle time.
    // Warms the brotli WASM decoder, imports the read-path module, and
    // fetches the schedule-tile manifest so Phase 2 can resolve coords.
    useEffect(() => {
      if (!mapReady) return;
      const ric = (window.requestIdleCallback as ((f: () => void) => void) | undefined) ?? ((f: () => void) => setTimeout(f, 1));
      ric(() =>
        void prewarmPhase1({
          warmupBrotli,
          warmManifest: async () => {
            await (await import("../../services/scheduleTileReadPath.ts")).warmManifest();
          },
          importReadPath: () => import("../../services/scheduleTileReadPath.ts"),
        })
      );
    }, [mapReady]);

    // Initialize map
    useEffect(() => {
      if (!containerRef.current || mapRef.current) return;

      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      currentMapThemeRef.current = isDark ? "dark" : "light";
      // Reopen where the user left off. An explicit `center` prop still wins
      // (callers that target a specific point); otherwise restore the saved
      // viewport — but only if it belongs to the city actually booting, so a
      // viewport saved in city A can't paint A's geography under city B's data
      // (dev override / city changed without moving the map). Falls back to
      // the active city's centroid on first launch or a city mismatch.
      //
      // Skip the restore entirely when startup-locate is on: the load handler
      // immediately flies to the user's GPS position, so restoring first would
      // only cause a visible double-jump (and the locate animation would then
      // overwrite the saved viewport).
      const saved = center || autoLocateOnLoadRef.current ? null : loadViewport(useCityStore.getState().activeCity.id);
      const restore =
        saved && saved.cityId === useCityStore.getState().activeCity.id ? saved : null;
      const c = center ?? (restore ? { lat: restore.lat, lon: restore.lon } : getDefaultCenter());

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: buildLocalStyle(isDark),
        center: [c.lon, c.lat],
        zoom: restore?.zoom ?? zoom,
        bearing: restore?.bearing ?? 0,
        pitch: restore?.pitch ?? 0,
        transformRequest: (url, resourceType) =>
          resourceType === "Glyphs"
            ? { url: localGlyphRequest(url, window.location.origin) }
            : undefined,
      });

      installAttributionAutoHide(
        map,
        typeof localStorage !== "undefined" ? localStorage : undefined,
      );

      map.addControl(
        new maplibregl.NavigationControl({ showCompass: false }),
        "bottom-right"
      );

      const geolocate = new LocateControl(
        (key, fallback) => translateRef.current(key, fallback),
        (position) => onGeolocateRef.current?.(position),
      );
      map.addControl(geolocate, "bottom-right");
      geolocateRef.current = geolocate;
      trackBottomControlInsets(map);
      trackSheetControlLift(map);

      map.on("load", () => {
        setMapReady(true);
        publishViewport(map);
        onMapReadyRef.current?.(map);
        // Opt-in (settings.startupLocate): fly to the user's GPS position on
        // load. Uses the shared location watch and recenter control. Off by
        // default — most launches restore the saved viewport without a GPS prompt.
        if (autoLocateOnLoadRef.current) {
          try {
            geolocate.trigger("startup");
          } catch {
            // Geolocation unsupported / control not ready — non-fatal.
          }
        }
        // Kick off basemap upgrade — silently falls back to the local meta-map
        // if the network/CDN is unreachable.
        void loadCarto();
      });

      const loadCarto = async (): Promise<void> => {
        if (localMapOnlyRef.current) return;
        if (cartoStateRef.current.status === "loading") return;
        const dark =
          document.documentElement.getAttribute("data-theme") === "dark";
        const ctrl = new AbortController();
        cartoStateRef.current = { status: "loading", abortCtrl: ctrl };
        const timer = setTimeout(
          () => ctrl.abort(new DOMException("basemap-timeout", "AbortError")),
          resolveBasemapTimeoutMs(),
        );
        try {
          const cartoStyle = await fetchBasemapStyle({
            providerId: "carto",
            dark,
            signal: ctrl.signal,
            getPolicy,
          });
          if (
            !cartoStyle ||
            localMapOnlyRef.current ||
            getPolicy().basemapMode !== "external-detailed"
          ) {
            cartoStateRef.current = { status: "idle", abortCtrl: null };
            return;
          }
          // Theme may have flipped during the fetch — drop stale result.
          const stillCurrent =
            dark ===
            (document.documentElement.getAttribute("data-theme") === "dark");
          if (!stillCurrent) {
            cartoStateRef.current = {
              status: cartoAppliedRef.current ? "loaded" : "idle",
              abortCtrl: null,
            };
            void loadCarto();
            return;
          }
          const stopsBeforeId = map.getLayer(CITY_LAYER) ? CITY_LAYER : undefined;
          const resources = collectNewBasemapResources(map, cartoStyle);
          mergeCartoIntoRunningMap(map, cartoStyle, stopsBeforeId);
          cartoResourcesRef.current = resources;
          cartoAppliedRef.current = true;
          cartoStateRef.current = {
            status:
              !localMapOnlyRef.current &&
              getPolicy().basemapMode === "external-detailed"
                ? "loaded"
                : "idle",
            abortCtrl: null,
          };
          setGlyphsReady(true);
        } catch {
          cartoStateRef.current = {
            status:
              !localMapOnlyRef.current &&
              getPolicy().basemapMode === "external-detailed"
                ? "failed"
                : "idle",
            abortCtrl: null,
          };
        } finally {
          clearTimeout(timer);
        }
      };
      loadCartoRef.current = loadCarto;

      const onOnline = () => {
        if (!BASEMAP_RETRY_ON_ONLINE) return;
        if (cartoStateRef.current.status === "failed") {
          void loadCarto();
        }
      };
      window.addEventListener("online", onOnline);

      // Long-press gesture: fires after LONG_PRESS_MS of pointer-down with
      // < LONG_PRESS_MAX_MOVE_PX of movement. Emits the raw lng/lat into
      // mapTapStore for the action sheet to consume. Cancelled by drag,
      // zoom, multi-touch, or release before the timer.
      let pressTimer: ReturnType<typeof setTimeout> | null = null;
      let pressStart: { x: number; y: number } | null = null;
      let pressLngLat: { lat: number; lng: number } | null = null;
      let longPressFired = false;

      const cancelPress = () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
        pressStart = null;
        pressLngLat = null;
      };

      const startPress = (
        point: { x: number; y: number },
        lngLat: { lat: number; lng: number }
      ) => {
        cancelPress();
        longPressFired = false;
        pressStart = { x: point.x, y: point.y };
        pressLngLat = { lat: lngLat.lat, lng: lngLat.lng };
        pressTimer = setTimeout(() => {
          if (pressLngLat) {
            longPressFired = true;
            useMapTapStore
              .getState()
              .emitTap(pressLngLat.lat, pressLngLat.lng);
          }
          pressTimer = null;
        }, LONG_PRESS_MS);
      };

      const movePress = (point: { x: number; y: number }) => {
        if (!pressStart) return;
        const dx = point.x - pressStart.x;
        const dy = point.y - pressStart.y;
        if (Math.hypot(dx, dy) > LONG_PRESS_MAX_MOVE_PX) {
          cancelPress();
        }
      };

      map.on("mousedown", (e) => startPress(e.point, e.lngLat));
      map.on("mousemove", (e) => movePress(e.point));
      map.on("mouseup", cancelPress);
      map.on("touchstart", (e) => {
        if (e.points.length !== 1) {
          cancelPress();
          return;
        }
        startPress(e.point, e.lngLat);
      });
      map.on("touchmove", (e) => {
        if (e.points.length !== 1) {
          cancelPress();
          return;
        }
        movePress(e.point);
      });
      map.on("touchend", cancelPress);
      map.on("touchcancel", cancelPress);
      map.on("dragstart", cancelPress);
      map.on("zoomstart", cancelPress);

      // Map click — only fire if not clicking on a feature layer
      map.on("click", (e) => {
        // Suppress the click that fires after a long-press release so the
        // map-tap doesn't double-trigger as a stop-deselect or onMapClick.
        if (longPressFired) {
          longPressFired = false;
          return;
        }
        // Check if the click hit any of our interactive layers (guard against layers not yet added)
        const queryLayers = [CITY_LAYER, DOT_LAYER].filter((id) =>
          map.getLayer(id)
        );
        if (queryLayers.length > 0) {
          const features = map.queryRenderedFeatures(e.point, {
            layers: queryLayers,
          });
          if (features.some(feature => feature.layer.id === CITY_LAYER ||
            stopsRef.current.some(stop => stop.id === feature.properties?.id))) return;
        }
        onMapClickRef.current?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      });

      // City marker click → zoom into that city
      map.on("click", CITY_LAYER, (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const geometry = feature.geometry as GeoJSON.Point;
        map.easeTo({
          center: geometry.coordinates as [number, number],
          zoom: DEFAULT_ZOOM,
        });
      });

      // Stop dot click → find stop and call onStopClick. A null lookup
      // means the dot's feature id isn't in the current stops snapshot
      // — a benign race between the debounced source.setData and a
      // user tap on a stop that was just filtered out. Log so it's
      // visible during diagnosis without paging on every miss.
      map.on("click", DOT_LAYER, (e) => {
        if (!e.features?.[0]) return;
        const stopId = e.features[0].properties?.id;
        const stop = stopsRef.current.find((s) => s.id === stopId);
        if (stop) onStopClickRef.current?.(stop);
        else console.debug("[stop-click] dot stop not in snapshot", { stopId });
      });

      // HTML-marker (card) click — delegated on the canvas container
      // (see markerClickDelegation.ts for the rationale). Bubble phase:
      // relies on no marker child calling `stopPropagation()`.
      const onMarkerCardClick = (e: MouseEvent) => {
        const stopId = findMarkerStopId(e.target);
        if (!stopId) return;
        const stop = stopsRef.current.find((s) => s.id === stopId);
        if (stop) onStopClickRef.current?.(stop);
        else console.debug("[stop-click] card stop not in snapshot", { stopId });
      };
      const canvasContainer = map.getCanvasContainer();
      canvasContainer.addEventListener("click", onMarkerCardClick);

      // Cursor styles for interactive layers
      map.on("mouseenter", CITY_LAYER, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", CITY_LAYER, () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("mouseenter", DOT_LAYER, (e) => {
        const id = e.features?.[0]?.properties?.id;
        map.getCanvas().style.cursor = stopsRef.current.some(stop => stop.id === id) ? "pointer" : "";
      });
      map.on("mouseleave", DOT_LAYER, () => {
        map.getCanvas().style.cursor = "";
      });

      // Zoom/move end → update station card markers (debounced)
      map.on("zoomend", debouncedUpdateMarkers);
      map.on("moveend", debouncedUpdateMarkers);
      // …and re-resolve screen-space label overlaps (Phase 3, debounced).
      map.on("moveend", debouncedResolveLabels);

      // Phase 2 prewarm: after each moveend, speculatively fetch the schedule
      // tile under the viewport centre. Gated on the dot layer being visible
      // (< MIN_DOTS_TO_PREWARM features → no-op) and the manifest being warm
      // (Phase 1 may not have run yet). The getLayer guard inside prewarmPhase2
      // also no-ops while the dot layer is absent after a style reload; the
      // next moveend re-fires naturally. lastWarmed keys on bundleHash so a
      // bundle roll invalidates it without any extra reset here.
      let prewarmDebounce: ReturnType<typeof setTimeout> | null = null;
      map.on("moveend", () => {
        if (prewarmDebounce) clearTimeout(prewarmDebounce);
        prewarmDebounce = setTimeout(() => {
          void (async () => {
            const rp = await import("../../services/scheduleTileReadPath.ts");
            const cache = await import("../../services/scheduleTileCache.ts");
            const m = rp.currentManifest();
            if (!m) return; // manifest not warmed yet (Phase 1 may not have run) — skip
            await prewarmPhase2(
              {
                getLayer: (id) => map.getLayer(id),
                queryRenderedFeatures: (o) => map.queryRenderedFeatures(undefined, o),
                getCenter: () => map.getCenter(),
                getZoom: () => map.getZoom(),
              },
              {
                dotLayerId: DOT_LAYER,
                bundleHash: () => rp.currentBundleHash(),
                resolveCoords: (lat, lng) => rp.resolveTileCoordsForLatLon(m, lat, lng),
                fetchTile: async (hash, coords) => {
                  const got = await cache.getDecodedTile(hash, SCHEDULE_TILE_SIZE_LABEL, coords, { prewarm: true });
                  return "tile" in got ? got.bytesDownloaded : 0;
                },
              },
            );
          })().catch(() => {});
        }, 500);
      });

      // Pan-to-switch: detect when viewport enters another city's bbox
      const citySwitcher = createPanCitySwitcher(map);
      let saveDebounce: ReturnType<typeof setTimeout> | null = null;
      let lastSavedKey = "";
      map.on("moveend", (e: maplibregl.MapLibreEvent & { originalEvent?: unknown }) => {
        // Guard: skip city-switch detection during programmatic flyTo animations.
        // MapLibre fires intermediate moveend events during multi-phase flyTo
        // where isMoving() is true. The terminal moveend has isMoving()===false,
        // so city-switch logic will execute once the animation completes.
        if (map.isMoving()) return;
        // Persist the settled viewport so the next launch reopens here.
        //   - Only USER-driven moves (drag/pinch/wheel carry an originalEvent)
        //     are saved. Programmatic flyTo terminals — city-switch centroid,
        //     cluster-expand zoom, startup geolocate — have no originalEvent
        //     and must NOT overwrite "where the user left off."
        //   - Tagged with the city the coordinates actually fall in, NOT the
        //     active city: a pan-to-switch settles in the new city's bbox while
        //     setActiveCity runs in the next task, so reading the
        //     active city here would mis-tag a viewport in city B as city A and
        //     let it restore under A's data. findCityByLocation keeps the tag
        //     honest; fall back to the active city for centers in a bbox gap.
        //   - Debounced + dirty-checked so a flick of pans doesn't hammer
        //     synchronous localStorage on the interaction-sensitive main thread.
        if (e.originalEvent) {
          const settled = map.getCenter();
          const next = {
            cityId:
              findCityByLocation(settled.lat, settled.lng)?.id ??
              useCityStore.getState().activeCity.id,
            lat: settled.lat,
            lon: settled.lng,
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch(),
          };
          const key = `${next.cityId}|${next.lat}|${next.lon}|${next.zoom}|${next.bearing}|${next.pitch}`;
          if (key !== lastSavedKey) {
            if (saveDebounce) clearTimeout(saveDebounce);
            saveDebounce = setTimeout(() => {
              if (saveViewport(next, stopsRef.current)) lastSavedKey = key;
            }, 400);
          }
        }
        citySwitcher.schedule();
      });

      mapRef.current = map;
      let renderedStops = new Set<string>();
      let canvasRect = map.getCanvas().getBoundingClientRect();
      stopFadeRef.current = new StopFade({
        // One rendered-feature query per reconcile/frame, never per stop.
        // MapLibre accounts for symbol collision and partially visible dots.
        prepareVisibility: () => {
          const canvas = map.getCanvas();
          canvasRect = canvas.getBoundingClientRect();
          const layers = [DOT_LAYER, LABEL_LAYER].filter(id => !!map.getLayer(id));
          renderedStops = new Set(layers.length ? map.queryRenderedFeatures(
            [[0, 0], [canvas.clientWidth, canvas.clientHeight]], {layers},
          ).flatMap(feature => typeof feature.properties?.id === "string" ? [feature.properties.id] : []) : []);
        },
        onscreen: (stop) => {
          if (renderedStops.has(stop.id)) return true;
          const card = markersRef.current.get(stop.id)?.getElement().querySelector<HTMLElement>(".cursor-pointer");
          const rect = card?.getBoundingClientRect();
          return !!rect && rect.width > 0 && rect.height > 0 && rect.right > canvasRect.left &&
            rect.left < canvasRect.right && rect.bottom > canvasRect.top && rect.top < canvasRect.bottom;
        },
        reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        opacity: (id, opacity, exiting) => {
          if (map.getSource(SOURCE_ID)) map.setFeatureState({ source: SOURCE_ID, id }, { exitOpacity: opacity });
          const marker = markersRef.current.get(id);
          // MapLibre reapplies its own opacity during camera/render updates.
          marker?.setOpacity(opacity, opacity * 0.2);
          const el = marker?.getElement();
          if (el) {
            el.inert = exiting;
            el.style.pointerEvents = exiting ? "none" : "";
          }
        },
        changed: () => {
          const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
          if (source) updateStopSource(source, buildGeoJSON(stopsRef.current));
          updateMarkers();
          debouncedResolveLabels();
        },
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (id) => cancelAnimationFrame(id),
      });

      // Expose map for e2e testing
      if (import.meta.env.DEV || import.meta.env.VITE_E2E) {
        (window as unknown as Record<string, unknown>).__ptnMap = map;
      }

      return () => {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
        if (labelResolveTimerRef.current) {
          clearTimeout(labelResolveTimerRef.current);
        }
        if (prewarmDebounce) clearTimeout(prewarmDebounce);
        citySwitcher.dispose();
        if (saveDebounce) clearTimeout(saveDebounce);
        cancelPress();
        canvasContainer.removeEventListener("click", onMarkerCardClick);
        stopFadeRef.current?.dispose();
        stopFadeRef.current = null;
        if (placementFrameRef.current !== null) cancelAnimationFrame(placementFrameRef.current);
        placementFrameRef.current = null;
        removeAllMarkers();
        window.removeEventListener("online", onOnline);
        cartoStateRef.current.abortCtrl?.abort();
        cartoStateRef.current = { status: "idle", abortCtrl: null };
        cartoAppliedRef.current = false;
        cartoResourcesRef.current = NO_BASEMAP_RESOURCES;
        loadCartoRef.current = null;
        if (import.meta.env.DEV || import.meta.env.VITE_E2E) {
          delete (window as unknown as Record<string, unknown>).__ptnMap;
        }
        map.remove();
        mapRef.current = null;
        geolocateRef.current = null;
        setMapReady(false);
      };
    }, []);

    // Apply privacy changes to the running map. Replacing the external style
    // removes CARTO sources so future pans cannot request new tiles; browser
    // caches are left intact until the user clears downloaded data.
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !mapReady) return;

      if (basemapMode === "local-only" || localMapOnly) {
        const wasLoaded = cartoAppliedRef.current;
        cartoStateRef.current.abortCtrl?.abort();
        cartoStateRef.current = { status: "idle", abortCtrl: null };
        if (wasLoaded) {
          const isDark =
            document.documentElement.getAttribute("data-theme") === "dark";
          removeExternalBasemap(map, cartoResourcesRef.current, isDark);
          cartoAppliedRef.current = false;
          cartoResourcesRef.current = NO_BASEMAP_RESOURCES;
          setGlyphsReady(MAP_LABELS_MODE === "inline");
          map.once("idle", () => debouncedResolveLabels());
        }
        return;
      }

      if (
        cartoStateRef.current.status === "idle" ||
        cartoStateRef.current.status === "failed"
      ) {
        void loadCartoRef.current?.();
      }
    }, [basemapMode, localMapOnly, mapReady, debouncedResolveLabels]);

    // Update stops source and layers
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !mapReady) return;

      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      stopFadeRef.current?.reconcile(stops, geometryStops ?? stops, fadeContext, performance.now());
      const geojson = buildGeoJSON(stops);

      if (map.getSource(SOURCE_ID)) {
        updateStopSource(map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource, geojson);
      } else {
        // Stops plus one static marker per covered city. No clustering:
        // aggregates hid the streets of the city users were navigating.
        map.addSource(SOURCE_ID, {
          type: "geojson",
          data: geojson,
          promoteId: "id",
        });
        rememberStopSource(map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource, geojson);

        // Layer 1: covered-city markers, only when zoomed far out
        map.addLayer({
          id: CITY_LAYER,
          type: "circle",
          source: SOURCE_ID,
          filter: IS_CITY,
          maxzoom: ZOOM_OVERVIEW_MAX,
          paint: {
            "circle-color": "#1d4ed8",
            "circle-radius": ["get", "radius"],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });

        // Layer 2: Individual stop dots, small until the city fills the view
        map.addLayer({
          id: DOT_LAYER,
          type: "circle",
          source: SOURCE_ID,
          filter: IS_STOP,
          minzoom: ZOOM_DOTS_MIN,
          paint: {
            "circle-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              ZOOM_DOTS_MIN,
              1.5,
              12,
              3,
              16,
              6,
            ],
            "circle-color": "#ffffff",
            "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], ZOOM_DOTS_MIN, 1, 12, 2],
            "circle-stroke-color": "#1e40af",
            "circle-opacity": ["*", ["coalesce", ["feature-state", "exitOpacity"], 1], ["case", ["boolean", ["feature-state", "hidden"], false], 0.35, 1]],
            "circle-stroke-opacity": ["*", ["coalesce", ["feature-state", "exitOpacity"], 1], ["case", ["boolean", ["feature-state", "hidden"], false], 0.35, 1]],
          },
        });
      }

      // Text layers are added lazily: they need glyphs, which may arrive only
      // after Carto merges in "network" mode. Re-runs of this effect add them
      // when glyphsReady flips true.
      if (glyphsReady && MAP_LABELS_MODE !== "none") {
        if (!map.getLayer(CITY_LABEL_LAYER)) {
          map.addLayer({
            id: CITY_LABEL_LAYER,
            type: "symbol",
            source: SOURCE_ID,
            filter: IS_CITY,
            maxzoom: ZOOM_OVERVIEW_MAX,
            layout: {
              "text-field": ["get", "name"],
              "text-font": [...labelFontstack()],
              "text-size": 13,
              "text-offset": [0, 1.1],
              "text-anchor": "top",
            },
            paint: {
              "text-color": isDark ? "#e5e7eb" : "#1e3a8a",
              "text-halo-color": isDark ? "#1f2937" : "#ffffff",
              "text-halo-width": 2,
            },
          });
        }
        if (!map.getLayer(LABEL_LAYER)) {
          map.addLayer({
            id: LABEL_LAYER,
            type: "symbol",
            source: SOURCE_ID,
            filter: IS_STOP,
            minzoom: ZOOM_LABELS_MIN,
            maxzoom: ZOOM_CARDS_MIN,
            layout: {
              "text-field": ["get", "name"],
              "text-font": [...labelFontstack()],
              "text-size": 11,
              "text-offset": LABEL_TEXT_OFFSET_EXPR,
              "text-anchor": LABEL_TEXT_ANCHOR_EXPR,
            },
            paint: {
              "text-opacity": ["coalesce", ["feature-state", "exitOpacity"], 1],
              "text-color": isDark ? "#e5e7eb" : "#374151",
              "text-halo-color": isDark ? "#1f2937" : "#ffffff",
              "text-halo-width": 2.5,
              "text-halo-blur": 0.5,
            },
          });
        }
      }

      // Update markers after stops data changes
      updateMarkers();
      // Re-resolve label overlaps for the new stop set (no-op outside the band).
      debouncedResolveLabels();
    }, [stops, geometryStops, fadeContext, mapReady, glyphsReady, buildGeoJSON, updateMarkers, debouncedResolveLabels]);

    // ── Stage 2 road-hint preload (async, cached) ───────────────────────────────
    // Derive each stop's curb `side` ONCE per city +
    // stop-set, off the synchronous solve path. Builds a `shapesByStopId` map by
    // resolving each stop's serving routes (`stop.lines[].routeId`) → patterns
    // (`buildLinePatterns`) → `shapeId` → the decoded GTFS polyline, then calls
    // the pure `deriveStopHints`. Results land in `hintsByStopIdRef` and a final
    // `updateMarkers()` re-solves with hints attached.
    //
    // DISCOVERY / path chosen: a stop carries `lines: LineInfo[]`
    // ({ routeId, ... }) but no `shapeId`. The clean route→shape association is
    // the SAME chain `LineRouteOverlay` uses — `buildLinePatterns(routeId)`
    // (reads the in-memory RAPTOR index + Dexie) yields `LinePattern[]` each with
    // an optional `shapeId`, then `db.gtfsShapes.get(shapeId).encodedPolyline` →
    // `decodePolyline` → `LatLon[]`. Because that association is readily
    // available, the ~150 m haversine bbox fallback is NOT needed. Stops whose
    // routes carry no shape (legacy/shape-less feeds) simply get no polyline →
    // `deriveStopHints` returns `{ side: null }` for them (graceful
    // Stage-1, no regression).
    //
    // Cancellation guards city/stop-set reads and incremental geometry batches.
    // Geometry yields between small batches so rendering can continue; placement
    // stays Stage-1 until a complete, current result is ready.
    useEffect(() => {
      if (!mapReady) return;
      const stopsForRun = hintStops;
      const data = captureCityData(activeCity.id);
      // Never let a prior city/stop-set hint leak into the first solve for the
      // new geometry while the asynchronous route/shape reads are in flight.
      hintsByStopIdRef.current = new Map();
      if (stopsForRun.length === 0 || !hintIndex || hintCityId !== activeCity.id) {
        return;
      }
      updateMarkers();

      let cancelled = false;
      const hintAbort = new AbortController();

      (async () => {
        try {
          // Resolve every distinct routeId across the stop set to its decoded
          // shape polylines ONCE (memoized per routeId, and per shapeId within
          // the run), then fan back out to each serving stop. `buildLinePatterns`
          // is the authoritative route→shapeId resolver; a shape-less route
          // contributes no polyline.
          const routeIdToShapes = new Map<string, PatternPolyline[]>();
          const shapeCache = new Map<string, { lat: number; lon: number }[] | null>();

          const decodeShapeId = async (
            shapeId: string,
          ): Promise<{ lat: number; lon: number }[] | null> => {
            const cached = shapeCache.get(shapeId);
            if (cached !== undefined) return cached;
            let decoded: { lat: number; lon: number }[] | null = null;
            try {
              const row = await data.gtfsShapes.get(shapeId);
              if (row?.encodedPolyline) decoded = decodePolyline(row.encodedPolyline);
            } catch {
              decoded = null; // DB closed / schema upgrade mid-flight → no shape
            }
            shapeCache.set(shapeId, decoded);
            return decoded;
          };

          const shapesForRoute = async (
            routeId: string,
          ): Promise<PatternPolyline[]> => {
            const memo = routeIdToShapes.get(routeId);
            if (memo) return memo;
            const byShapeId = new Map<string, PatternPolyline>();
            try {
              const patterns = await buildLinePatterns(routeId);
              for (const p of patterns) {
                if (!p.shapeId) continue;
                const decoded = await decodeShapeId(p.shapeId);
                if (!decoded || decoded.length < 2) continue;
                const existing = byShapeId.get(p.shapeId);
                if (existing) {
                  for (const stop of p.stops) existing.stopIds.add(stop.id);
                } else {
                  byShapeId.set(p.shapeId, {
                    stopIds: new Set(p.stops.map((stop) => stop.id)),
                    polyline: decoded,
                  });
                }
              }
            } catch {
              // buildLinePatterns failed (e.g. index not yet ready) → no shapes.
            }
            const polylines = [...byShapeId.values()];
            routeIdToShapes.set(routeId, polylines);
            return polylines;
          };

          const shapesByStopId = new Map<string, { lat: number; lon: number }[][]>();
          for (const stop of stopsForRun) {
            if (cancelled) return;
            const lines = stop.lines ?? [];
            if (lines.length === 0) continue;
            const polylines: { lat: number; lon: number }[][] = [];
            const seenRoutes = new Set<string>();
            for (const line of lines) {
              if (seenRoutes.has(line.routeId)) continue;
              seenRoutes.add(line.routeId);
              const routePatterns = await shapesForRoute(line.routeId);
              for (const pl of polylinesServingStop(stop.id, routePatterns)) polylines.push(pl);
            }
            if (polylines.length > 0) shapesByStopId.set(stop.id, polylines);
          }

          if (cancelled) return;

          data.assertCurrent();
          // Pure derivation (geographic frame). `StopWithLines` already matches
          // the `StopLike` shape deriveStopHints reads ({ id, name, location,
          // parentStationId }).
          const hints = await deriveStopHintsAsync(stopsForRun, shapesByStopId, hintAbort.signal);
          if (cancelled) return;
          data.assertCurrent();
          hintsByStopIdRef.current = hints;

          // Re-solve so the freshly-derived hints take effect on the current
          // viewport without waiting for the next pan/zoom.
          updateMarkers();
        } catch (err) {
          // Hint derivation is best-effort: any failure leaves placement at
          // Stage-1. Report for telemetry but never throw into the effect.
          if (!cancelled && !(err instanceof Error && err.name === "AbortError")) {
            reportError(err instanceof Error ? err : new Error(String(err)), {
              context: { where: "TransitMap.deriveStopHints" },
            });
          }
        }
      })();

      return () => {
        cancelled = true;
        hintAbort.abort();
      };
      // Keyed on the city + stop-set identity (ids+routes), NOT the `stops` array
      // identity and NOT pan/zoom. `updateMarkers` is stable (reads refs).
    }, [stopSetKey, activeCity.id, mapReady, updateMarkers, hintIndex, hintCityId, cityDataRevision]);

    // Fly to user's geolocation once when first available
    useEffect(() => {
      if (!mapRef.current || !mapReady || !center) return;
      if (hasFlownToLocationRef.current) return;
      hasFlownToLocationRef.current = true;
      mapRef.current.flyTo({
        center: [center.lon, center.lat],
        zoom: Math.max(mapRef.current.getZoom(), ZOOM_CARDS_MIN),
      });
    }, [center, mapReady]);

    // Clear markers/cache when the city changes, and recenter ONLY when the
    // viewport isn't already showing the new city.
    useEffect(() => {
      if (!mapRef.current || !mapReady) return;
      // Only act when the city actually changed — skip re-fires caused by
      // mapReady toggling (e.g. theme switch cycling setMapReady).
      if (lastFlownCityRef.current === activeCity.id) return;
      lastFlownCityRef.current = activeCity.id;
      removeAllMarkers();
      measureCacheRef.current.clear();
      labelOverrideRef.current = new Map();
      prevOffsetsRef.current = new Map();
      dimmedIdsRef.current = new Set();
      // Pan-to-switch and locate-to-user have already moved the viewport into
      // the new city, so re-centering on its centroid would yank the user
      // away from where they are. Only fly when the map is somewhere else
      // (e.g. a programmatic / dev-override city switch).
      const ctr = mapRef.current.getCenter();
      if (findCityByLocation(ctr.lat, ctr.lng)?.id !== activeCity.id) {
        const saved = loadViewport(activeCity.id);
        mapRef.current.flyTo({
          center: saved ? [saved.lon, saved.lat] : [activeCity.center.lon, activeCity.center.lat],
          zoom: saved?.zoom ?? DEFAULT_ZOOM,
          bearing: saved?.bearing ?? 0,
          pitch: saved?.pitch ?? 0,
        });
      }
    }, [activeCity.id, mapReady, removeAllMarkers]);

    // Swap map style when theme changes (including system preference).
    // Two paths:
    //   - Local-only (Carto not loaded): paint the background layer directly.
    //   - Carto-loaded: fetch the opposite-theme Carto style, pre-merge stops
    //     so MapLibre's style-diff preserves them, then setStyle. The basemap
    //     layers flip, the stop dots don't flicker.
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !mapReady) return;

      const applyMapTheme = async () => {
        const isDark =
          document.documentElement.getAttribute("data-theme") === "dark";
        const resolved = isDark ? "dark" : "light";
        if (resolved === currentMapThemeRef.current) return;
        currentMapThemeRef.current = resolved;

        // Always refresh the local background color so a local-only map (or
        // the gaps between Carto tiles) matches the theme instantly.
        if (map.getLayer(LOCAL_BG_LAYER_ID)) {
          const bg = buildLocalStyle(isDark).layers[0];
          if (bg.type === "background" && bg.paint?.["background-color"]) {
            map.setPaintProperty(
              LOCAL_BG_LAYER_ID,
              "background-color",
              bg.paint["background-color"],
            );
          }
        }

        if (!cartoAppliedRef.current) return;

        // Cancel any in-flight Carto fetch from a previous theme.
        cartoStateRef.current.abortCtrl?.abort();

        const ctrl = new AbortController();
        cartoStateRef.current = { status: "loading", abortCtrl: ctrl };
        const timer = setTimeout(
          () => ctrl.abort(new DOMException("basemap-timeout", "AbortError")),
          resolveBasemapTimeoutMs(),
        );
        try {
          const cartoStyle = await fetchBasemapStyle({
            providerId: "carto",
            dark: isDark,
            signal: ctrl.signal,
            getPolicy,
          });
          if (
            !cartoStyle ||
            localMapOnlyRef.current ||
            getPolicy().basemapMode !== "external-detailed"
          ) {
            cartoStateRef.current = { status: "idle", abortCtrl: null };
            return;
          }

          // Grab current stops source + layers to pre-merge into the new
          // style. Diff preserves matching entries, so stops stay on screen
          // across the swap with no tear-down blink.
          const currentStyle = map.getStyle();
          const stopsSource = currentStyle.sources?.[SOURCE_ID];
          const stopsLayers = (currentStyle.layers ?? []).filter((l) =>
            [CITY_LAYER, CITY_LABEL_LAYER, DOT_LAYER, LABEL_LAYER].includes(
              l.id,
            ),
          );
          if (!stopsSource) {
            map.setStyle(cartoStyle as unknown as maplibregl.StyleSpecification);
          } else {
            const merged = buildMergedCartoStyle(
              cartoStyle,
              { id: SOURCE_ID, definition: stopsSource },
              stopsLayers,
            );
            map.setStyle(merged);
          }
          cartoResourcesRef.current = {
            sourceIds: Object.keys(cartoStyle.sources ?? {}),
            layerIds: (cartoStyle.layers ?? []).map((layer) => layer.id),
          };
          cartoAppliedRef.current = true;
          // Stage 1b: a style swap drops the dimmed-dot feature-state, so a
          // re-solve must re-apply it once the new style settles (the `idle`
          // event after style load + first render) — otherwise hidden labels
          // briefly un-dim until the next pan/zoom. Harmless no-op when hard-hide
          // is rolled back off (just an extra end-of-gesture-class solve).
          map.once("idle", () => debouncedResolveLabels());
          cartoStateRef.current = {
            status:
              !localMapOnlyRef.current &&
              getPolicy().basemapMode === "external-detailed" &&
              cartoAppliedRef.current
                ? "loaded"
                : "idle",
            abortCtrl: null,
          };
        } catch {
          // Theme swap fetch failed — the old Carto basemap is still on
          // screen for the previous theme. Not ideal, but better than a
          // teardown that leaves the user with a blank map.
          cartoStateRef.current = {
            status:
              !localMapOnlyRef.current &&
              getPolicy().basemapMode === "external-detailed"
                ? "loaded"
                : "idle",
            abortCtrl: null,
          };
        } finally {
          clearTimeout(timer);
        }
      };

      void applyMapTheme();

      // Also listen for system preference changes to catch real-time OS toggles
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      const onSystemChange = () => {
        if (useSettingsStore.getState().theme === "system") {
          // Wait a tick for settingsStore to update data-theme first
          requestAnimationFrame(() => {
            void applyMapTheme();
          });
        }
      };
      mql.addEventListener("change", onSystemChange);
      return () => mql.removeEventListener("change", onSystemChange);
    }, [theme, mapReady]);

    return (
      <div ref={containerRef} className={`w-full h-full ${className}`} />
    );
  }
);
