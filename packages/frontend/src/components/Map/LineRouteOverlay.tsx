import { useEffect, useRef } from "react";
import { useCityDataQuery } from "../../hooks/useCityDataQuery.ts";
import maplibregl from "../../map/maplibre.ts";
import { useLineViewStore } from "../../stores/lineViewStore.ts";
import { type GtfsShapeRecord, type GtfsStopRecord } from "../../db/index.ts";
import { buildTransitGeometry } from "../../services/legGeometry/buildTransitGeometry.ts";
import type { LinePattern } from "../../stores/lineViewStore.ts";
import { Icon } from "../Icon.tsx";
import { useRegisterMapObstacle } from "../../hooks/useRegisterMapObstacle.ts";
import { labelFontstack } from "../../map/styleBuilder.ts";

const LINE_SOURCE = "line-route-source";
const LINE_LAYER = "line-route-line";
const STOPS_SOURCE = "line-stops-source";
const STOPS_LAYER = "line-stops-dots";
const STOPS_LABEL_LAYER = "line-stops-labels";

interface LineRouteOverlayProps {
  map: maplibregl.Map | null;
}

/**
 * Build the route geometry for a line pattern. Uses `buildTransitGeometry`
 * with an explicit `stopIds` array drawn from the pattern itself, so the
 * result follows pattern order — independent of any potential direction
 * drift in the canonical `gtfsRoutes.stopIds` list.
 *
 * When a shape is supplied (resolved by the caller from `pattern.shapeId`
 * via `gtfsShapes`), `buildTransitGeometry` returns the road-following
 * polyline. Otherwise we fall back to the stop-chord intermediate tier.
 *
 * When `stopRows` is undefined (first render, Dexie bulkGet pending) we
 * synthesise rows from the pattern's inline coordinates so the overlay
 * still renders immediately from in-memory data.
 */
export function geometryFor(
  pattern: LinePattern,
  stopRows: Array<GtfsStopRecord | undefined> | undefined,
  shape?: GtfsShapeRecord,
): { coords: [number, number][] } {
  const explicitStopIds = pattern.stops.map((s) => s.id);
  if (explicitStopIds.length === 0) {
    return { coords: [] };
  }
  const fromLocation = pattern.stops[0].location;
  const toLocation = pattern.stops[pattern.stops.length - 1].location;

  // While Dexie is loading, synthesise stop rows from the pattern's inline
  // coordinates so buildTransitGeometry still returns the intermediate tier.
  const stops: Array<{ id: string; lat: number; lon: number } | undefined> =
    stopRows ??
    pattern.stops.map((s) =>
      s.location &&
      Number.isFinite(s.location.lat) &&
      Number.isFinite(s.location.lon)
        ? { id: s.id, lat: s.location.lat, lon: s.location.lon }
        : undefined,
    );

  const result = buildTransitGeometry({
    kind: "stopIds",
    explicitStopIds,
    fromLocation,
    toLocation,
    stops,
    shape,
  });
  // LonLat is readonly; GeoJSON consumers downstream expect mutable [number, number].
  return { coords: result.coords as unknown as [number, number][] };
}

/**
 * Renders a transit line's route shape (polyline connecting stops) and
 * stop markers on the MapLibre map. Reads state from lineViewStore.
 *
 * Also renders a floating direction toggle button when multiple patterns exist.
 */
export function LineRouteOverlay({ map }: LineRouteOverlayProps) {
  const isVisible = useLineViewStore((s) => s.isVisible);
  const patterns = useLineViewStore((s) => s.patterns);
  const activeDirection = useLineViewStore((s) => s.activeDirection);
  const activeRouteColor = useLineViewStore((s) => s.activeRouteColor);
  const activeRouteShortName = useLineViewStore((s) => s.activeRouteShortName);
  const toggleDirection = useLineViewStore((s) => s.toggleDirection);
  const hideLine = useLineViewStore((s) => s.hideLine);
  const layersAddedRef = useRef(false);

  const pattern = patterns[activeDirection] ?? patterns[0] ?? null;
  const hasMultipleDirections = patterns.length > 1;

  const directionToggleRef = useRegisterMapObstacle<HTMLDivElement>(
    "line-direction-toggle",
    isVisible && hasMultipleDirections,
  );
  const routeLabelRef = useRegisterMapObstacle<HTMLDivElement>(
    "line-route-label",
    isVisible && pattern !== null,
  );

  // Fetch canonical stop coordinates from Dexie keyed by the pattern's
  // stopIds. This is what lets `buildTransitGeometry` follow the pattern's
  // order rather than any canonical `gtfsRoutes.stopIds` that may have
  // drifted direction.
  const stopIds = pattern?.stops.map((s) => s.id) ?? [];
  const stopIdsKey = stopIds.join(",");
  const stopRows = useCityDataQuery(
    async (data) => {
      if (stopIds.length === 0) return [];
      return data.gtfsStops.bulkGet(stopIds);
    },
    [stopIdsKey],
  );

  // Resolve the GTFS shape for this pattern. `pattern.shapeId` is set by
  // `buildLinePatterns` when a representative trip carries one; absent
  // → falls through to the stop-chord intermediate tier. Wrap the
  // resolved value in `{ resolved: true, shape }` so we can distinguish
  // "still pending" (useLiveQuery returns `undefined`) from "Dexie row
  // missing" (returns `{ resolved: true, shape: undefined }`) — needed
  // for the drift-detection log below.
  const shapeId = pattern?.shapeId;
  const shapeQuery = useCityDataQuery(
    async (data) => {
      if (!shapeId) return { resolved: true, shape: undefined };
      const row = await data.gtfsShapes.get(shapeId);
      return { resolved: true, shape: row };
    },
    [shapeId],
  );
  const shape = shapeQuery?.shape;
  // Logged once per shapeId per session — when a user reports "the line
  // is straight, not following roads", we need to distinguish "feed has
  // no shape" (no log) from "shape was promised but the Dexie row is
  // missing" (this log) from "shape resolved" (no log). `shapeQuery`
  // being defined means Dexie has emitted at least once.
  const warnedMissingShapeRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      shapeId &&
      shapeQuery &&
      shapeQuery.shape === undefined &&
      warnedMissingShapeRef.current !== shapeId
    ) {
      warnedMissingShapeRef.current = shapeId;
      console.warn(
        `[LineRouteOverlay] gtfsShapes.get(${shapeId}) returned no record; falling back to stop-chord`,
      );
    }
  }, [shapeId, shapeQuery]);

  // Manage MapLibre sources and layers
  useEffect(() => {
    if (!map) return;

    const cleanup = () => {
      if (map.getLayer(STOPS_LABEL_LAYER)) map.removeLayer(STOPS_LABEL_LAYER);
      if (map.getLayer(STOPS_LAYER)) map.removeLayer(STOPS_LAYER);
      if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
      if (map.getSource(STOPS_SOURCE)) map.removeSource(STOPS_SOURCE);
      if (map.getSource(LINE_SOURCE)) map.removeSource(LINE_SOURCE);
      layersAddedRef.current = false;
    };

    if (!isVisible || !pattern) {
      cleanup();
      return;
    }

    const stops = pattern.stops;
    if (stops.length === 0) {
      console.warn(
        "[LineRouteOverlay] pattern has no stops — skipping map render",
      );
      cleanup();
      return;
    }

    const { coords } = geometryFor(pattern, stopRows, shape);
    if (coords.length < 2) {
      console.warn(
        `[LineRouteOverlay] pattern has ${stops.length} stops but fewer than 2 coordinates resolved — skipping map render`,
      );
      cleanup();
      return;
    }

    const routeColor = activeRouteColor
      ? `#${activeRouteColor.replace(/^#/, "")}`
      : "#3b82f6";

    // Build GeoJSON for the line connecting stops — coords follow the
    // pattern's stopId order (via buildTransitGeometry + explicitStopIds).
    const lineGeoJSON: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: coords,
          },
          properties: {},
        },
      ],
    };

    // Build GeoJSON for stop points from the pattern's stops, not from
    // line coords — when the shape tier is active, `coords` are the dense
    // shape vertices and don't align 1:1 with stops. Stop dots always
    // anchor to the canonical stop locations.
    const stopsGeoJSON: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: stops.map((stop, i) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [stop.location.lon, stop.location.lat],
        },
        properties: {
          id: stop.id,
          name: stop.name,
          index: i,
          isTerminal: i === 0 || i === stops.length - 1,
        },
      })),
    };

    const isDark =
      document.documentElement.getAttribute("data-theme") === "dark";

    if (layersAddedRef.current) {
      // Update existing sources
      const lineSrc = map.getSource(LINE_SOURCE) as maplibregl.GeoJSONSource;
      const stopsSrc = map.getSource(STOPS_SOURCE) as maplibregl.GeoJSONSource;
      if (lineSrc) lineSrc.setData(lineGeoJSON);
      if (stopsSrc) stopsSrc.setData(stopsGeoJSON);

      // Update line color
      if (map.getLayer(LINE_LAYER)) {
        map.setPaintProperty(LINE_LAYER, "line-color", routeColor);
      }
      if (map.getLayer(STOPS_LAYER)) {
        map.setPaintProperty(STOPS_LAYER, "circle-stroke-color", routeColor);
      }
    } else {
      // Clean up any stale layers first
      cleanup();

      // Add line source + layer
      map.addSource(LINE_SOURCE, {
        type: "geojson",
        data: lineGeoJSON,
      });

      map.addLayer({
        id: LINE_LAYER,
        type: "line",
        source: LINE_SOURCE,
        paint: {
          "line-color": routeColor,
          "line-width": 4,
          "line-opacity": 0.8,
        },
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
      });

      // Add stops source + layers
      map.addSource(STOPS_SOURCE, {
        type: "geojson",
        data: stopsGeoJSON,
      });

      map.addLayer({
        id: STOPS_LAYER,
        type: "circle",
        source: STOPS_SOURCE,
        paint: {
          "circle-radius": [
            "case",
            ["get", "isTerminal"],
            7,
            5,
          ],
          "circle-color": "#ffffff",
          "circle-stroke-width": 2.5,
          "circle-stroke-color": routeColor,
        },
      });

      map.addLayer({
        id: STOPS_LABEL_LAYER,
        type: "symbol",
        source: STOPS_SOURCE,
        layout: {
          "text-field": ["get", "name"],
          "text-font": [...labelFontstack()],
          "text-size": 11,
          "text-offset": [0, 1.5],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": isDark ? "#e5e7eb" : "#374151",
          "text-halo-color": isDark ? "#1f2937" : "#ffffff",
          "text-halo-width": 1.5,
        },
      });

      layersAddedRef.current = true;
    }

    // Fit map bounds to the route
    const lngs = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    const bounds = new maplibregl.LngLatBounds(
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    );
    map.fitBounds(bounds, { padding: 60, maxZoom: 16 });

    return cleanup;
  }, [map, isVisible, pattern, activeRouteColor, stopRows, shape]);

  if (!isVisible || !pattern) return null;

  return (
    <>
      {/* Direction toggle — floating button on the map */}
      {hasMultipleDirections && (
        <div
          ref={directionToggleRef}
          data-testid="line-direction-toggle"
          className="absolute bottom-24 left-3 z-20 flex flex-col items-center gap-1"
        >
          <button
            onClick={toggleDirection}
            className="flex items-center gap-1.5 px-3 py-2 bg-surface-raised
              rounded-full shadow-lg border border-divider
              text-sm font-medium transition-colors hover:bg-surface-overlay"
            aria-label={`Switch direction to ${patterns[(activeDirection + 1) % patterns.length]?.headsign ?? "next"}`}
          >
            <svg
              className="w-4 h-4 text-fg"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16l-4-4m0 0l4-4m-4 4h18M17 8l4 4m0 0l-4 4"
              />
            </svg>
            <span className="text-fg text-xs truncate max-w-[120px]">
              {pattern.headsign}
            </span>
          </button>
        </div>
      )}

      {/* Route label pill */}
      <div
        ref={routeLabelRef}
        data-testid="line-route-label"
        className="absolute top-20 left-1/2 -translate-x-1/2 z-20"
      >
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-raised
          rounded-full shadow-lg border border-divider">
          <span
            className="text-xs font-bold px-2 py-0.5 rounded text-badge-text"
            style={{
              "--route-color": activeRouteColor
                ? `#${activeRouteColor.replace(/^#/, "")}`
                : "#3b82f6",
              backgroundColor: "var(--route-color)",
            } as React.CSSProperties}
          >
            {activeRouteShortName}
          </span>
          <span className="text-xs text-fg-muted truncate max-w-[160px]">
            {pattern.headsign}
          </span>
          <button
            onClick={hideLine}
            className="ml-1 p-0.5 rounded-full hover:bg-surface-overlay"
            aria-label="Close line view"
            data-testid="line-view-close"
          >
            <Icon name="close" size={14} className="text-fg-muted" />
          </button>
        </div>
      </div>
    </>
  );
}
