import { useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { TransportMode } from "@pt/shared";
import type * as maplibregl from "maplibre-gl";
import { db } from "../../db/index.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useEffectiveMapMode } from "../../map/mapMode.ts";
import { readGtfsBundle, type RaptorBundleWire } from "../../services/gtfsBundle.ts";
import { BIKE_CIRCLE_LAYER, BIKE_LABEL_LAYER } from "./bikeShareFeatures.ts";
import {
  buildGtfsCorridorFeatureCollection,
  EMPTY_GTFS_CORRIDORS,
  GTFS_CORRIDOR_LAYER,
  GTFS_CORRIDOR_SOURCE,
  type GtfsCorridorFeatureCollection,
} from "./gtfsCorridors.ts";

interface GtfsCorridorLayerProps {
  map: maplibregl.Map | null;
}

const STOPS_CLUSTER_LAYER = "stops-clusters";
const LINE_ROUTE_LAYER = "line-route-line";
const GUIDANCE_PREVIEW_PREFIX = "guidance-leg-preview-layer-";
const GUIDANCE_LEG_PREFIX = "guidance-leg-layer-";

const CORRIDOR_LINE_COLOR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "mode"],
  "BUS",
  "#6f8fb7",
  "TRAM",
  "#5a9b75",
  "TROLLEYBUS",
  "#579996",
  "METRO",
  "#b96f78",
  "RAIL",
  "#a98662",
  "FERRY",
  "#5c99ad",
  "#8b95a1",
];

const CORRIDOR_LINE_WIDTH: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  9,
  ["+", 0.3, ["*", ["get", "importance"], 0.08]],
  13,
  ["+", 0.7, ["*", ["get", "importance"], 0.16]],
  17,
  ["+", 1.2, ["*", ["get", "importance"], 0.26]],
];

const CORRIDOR_LINE_OPACITY: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  9,
  0.16,
  13,
  0.26,
  17,
  0.34,
];

function removeCorridorLayer(map: maplibregl.Map): void {
  try {
    if (!map.getStyle()) return;
    if (map.getLayer(GTFS_CORRIDOR_LAYER)) {
      map.removeLayer(GTFS_CORRIDOR_LAYER);
    }
    if (map.getSource(GTFS_CORRIDOR_SOURCE)) {
      map.removeSource(GTFS_CORRIDOR_SOURCE);
    }
  } catch {
    // MapLibre can unset style internals during teardown; cleanup is best-effort.
  }
}

function isCorridorAnchor(id: string): boolean {
  return (
    id === STOPS_CLUSTER_LAYER ||
    id === BIKE_CIRCLE_LAYER ||
    id === BIKE_LABEL_LAYER ||
    id === LINE_ROUTE_LAYER ||
    id.startsWith(GUIDANCE_PREVIEW_PREFIX) ||
    id.startsWith(GUIDANCE_LEG_PREFIX)
  );
}

function findCorridorBeforeId(map: maplibregl.Map): string | undefined {
  try {
    return map.getStyle().layers?.find((layer) => isCorridorAnchor(layer.id))?.id;
  } catch {
    return undefined;
  }
}

function ensureCorridorOrder(map: maplibregl.Map): void {
  try {
    if (!map.getLayer(GTFS_CORRIDOR_LAYER)) return;
    const beforeId = findCorridorBeforeId(map);
    if (!beforeId) return;

    const layers = map.getStyle().layers ?? [];
    const corridorIdx = layers.findIndex((layer) => layer.id === GTFS_CORRIDOR_LAYER);
    const beforeIdx = layers.findIndex((layer) => layer.id === beforeId);
    if (corridorIdx === -1 || beforeIdx === -1 || corridorIdx < beforeIdx) return;
    map.moveLayer(GTFS_CORRIDOR_LAYER, beforeId);
  } catch {
    return;
  }
}

function upsertCorridorLayer(
  map: maplibregl.Map,
  data: GtfsCorridorFeatureCollection,
  refreshData = true,
): void {
  let styleLoaded: boolean;
  try {
    styleLoaded = map.isStyleLoaded() === true;
  } catch {
    return;
  }
  if (!styleLoaded || data.features.length === 0) {
    if (data.features.length === 0) removeCorridorLayer(map);
    return;
  }

  try {
    const existing = map.getSource(GTFS_CORRIDOR_SOURCE) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existing) {
      if (refreshData) existing.setData(data);
    } else {
      map.addSource(GTFS_CORRIDOR_SOURCE, {
        type: "geojson",
        data,
      });
    }

    if (!map.getLayer(GTFS_CORRIDOR_LAYER)) {
      map.addLayer(
        {
          id: GTFS_CORRIDOR_LAYER,
          type: "line",
          source: GTFS_CORRIDOR_SOURCE,
          minzoom: 9,
          layout: {
            "line-join": "round",
            "line-cap": "round",
          },
          paint: {
            "line-color": CORRIDOR_LINE_COLOR,
            "line-width": CORRIDOR_LINE_WIDTH,
            "line-opacity": CORRIDOR_LINE_OPACITY,
          },
        },
        findCorridorBeforeId(map),
      );
    }
  } catch {
    return;
  }

  ensureCorridorOrder(map);
}

function corridorsFromBundle(
  wire: RaptorBundleWire,
): GtfsCorridorFeatureCollection {
  return buildGtfsCorridorFeatureCollection({
    shapes: [],
    stops: wire.stops,
    routes: wire.routes.map((route) => ({
      id: route.id,
      mode: route.mode as TransportMode,
      stopIds: route.stopIds,
      directionPatterns: route.directionPatterns,
    })),
    trips: wire.routes.flatMap((route) =>
      route.trips.map((trip) => ({
        tripId: trip.tripId,
        routeId: route.id,
        shapeId: trip.shapeId,
      })),
    ),
  });
}

export async function loadGtfsCorridorFeatureCollection(
  cityId: string,
): Promise<GtfsCorridorFeatureCollection> {
  const meta = await db.gtfsSyncMeta.get("current");
  if (meta?.cityId === cityId) {
    const [shapes, trips, routes, stops] = await Promise.all([
      db.gtfsShapes.toArray(),
      db.gtfsTrips.toArray(),
      db.gtfsRoutes.toArray(),
      db.gtfsStops.toArray(),
    ]);
    const fromTables = buildGtfsCorridorFeatureCollection({
      shapes,
      trips,
      routes,
      stops,
    });
    if (fromTables.features.length > 0) return fromTables;
  }

  const wire = await readGtfsBundle(cityId);
  return wire ? corridorsFromBundle(wire) : EMPTY_GTFS_CORRIDORS;
}

/**
 * Local-only transit context map. GTFS shapes are vehicle paths, not a street
 * database, so this layer renders them as muted corridors under stops and
 * guidance overlays rather than as asserted roads.
 */
export function GtfsCorridorLayer({ map }: GtfsCorridorLayerProps) {
  const activeCityId = useCityStore((s) => s.activeCity.id);
  // Corridors are the transit half of every local map mode: on their own in
  // `gtfs-only`, and on top of the micromap's water/roads in `micromap`.
  const enabled = useEffectiveMapMode() !== "detailed";
  const dataRef = useRef<GtfsCorridorFeatureCollection>(EMPTY_GTFS_CORRIDORS);

  const corridors = useLiveQuery(
    async () => {
      if (!enabled) return EMPTY_GTFS_CORRIDORS;
      return loadGtfsCorridorFeatureCollection(activeCityId);
    },
    [enabled, activeCityId],
    EMPTY_GTFS_CORRIDORS,
  );

  useEffect(() => {
    dataRef.current = corridors;
    if (!map) return;
    if (!enabled) {
      removeCorridorLayer(map);
      return;
    }
    upsertCorridorLayer(map, corridors);
  }, [map, enabled, corridors]);

  useEffect(() => {
    if (!map || !enabled) return;
    const syncLayer = () => {
      upsertCorridorLayer(map, dataRef.current, false);
    };
    map.on("styledata", syncLayer);
    map.on("idle", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
      map.off("idle", syncLayer);
      removeCorridorLayer(map);
    };
  }, [map, enabled]);

  return null;
}
