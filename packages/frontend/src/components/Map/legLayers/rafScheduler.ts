import type * as maplibregl from "maplibre-gl";
import type { Leg, LegGeometryResult } from "@pt/shared";

// Id of the first (lowest-z) interactive stop layer owned by `TransitMap`.
// Leg layers are inserted below this via `beforeId` so all stop visuals —
// cluster bubbles, dots, labels — render above the overlay polyline and taps
// land on the stop markers rather than the line. Kept in sync with
// `TransitMap.tsx`'s `CLUSTER_LAYER` constant; the string is duplicated
// (not imported) to avoid a circular module dep between the map component
// and the scheduler.
const STOPS_LAYER = "stops-clusters";

const MODE_COLORS: Record<string, string> = {
  BUS: "#1d4ed8",
  TRAM: "#16a34a",
  TROLLEYBUS: "#0d9488",
  METRO: "#dc2626",
  RAIL: "#ea580c",
  FERRY: "#0891b2",
  WALK: "#6b7280",
};

type Pending = {
  leg: Leg;
  geom: LegGeometryResult;
  statusOpacity: number;
  type: "transit" | "walk";
};

let singletonMap: maplibregl.Map | null = null;
const pending: Map<number, Pending> = new Map();
let frame: number | null = null;
let pendingTokenValue: number | null = null;

function pendingOpacityMultiplier(): number {
  if (pendingTokenValue !== null) return pendingTokenValue;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--overlay-opacity-pending")
    .trim();
  const n = parseFloat(raw);
  pendingTokenValue = Number.isFinite(n) ? n : 0.5;
  return pendingTokenValue;
}

export function enqueueSetData(
  map: maplibregl.Map,
  index: number,
  type: "transit" | "walk",
  leg: Leg,
  geom: LegGeometryResult,
  statusOpacity: number,
): void {
  if (singletonMap !== map) {
    // Switching map instance: drop stale queue.
    pending.clear();
    singletonMap = map;
  }
  pending.set(index, { leg, geom, statusOpacity, type });
  if (frame === null) {
    frame = requestAnimationFrame(drain);
  }
}

function drain(): void {
  frame = null;
  const map = singletonMap;
  if (!map) {
    pending.clear();
    return;
  }
  for (const [index, p] of pending) apply(map, index, p);
  pending.clear();
}

function apply(map: maplibregl.Map, index: number, p: Pending): void {
  const sourceId = `guidance-leg-${index}`;
  const layerId = `guidance-leg-layer-${index}`;
  const opacity = paintOpacity(p.statusOpacity, p.geom);
  const geojson = {
    type: "Feature" as const,
    geometry: {
      type: "LineString" as const,
      // LonLat is readonly; GeoJSON Position expects a mutable number[].
      coordinates: p.geom.coords as unknown as [number, number][],
    },
    properties: {
      source: p.geom.source,
      partial: p.geom.partial,
      pending: p.geom.pending,
    },
  };
  const src = map.getSource(sourceId);
  if (!src) {
    map.addSource(sourceId, { type: "geojson", data: geojson });
    // Insert leg layers below the interactive stop markers so taps land on
    // the dots/clusters rather than the overlay polyline. Guard with a
    // getLayer check — on schedule-only mode the stop layer never exists,
    // and during mount the stop layer may be added after the first leg
    // enqueue, in which case `beforeId` must be undefined or MapLibre
    // throws about the missing reference layer.
    const beforeId = map.getLayer(STOPS_LAYER) ? STOPS_LAYER : undefined;
    map.addLayer(
      {
        id: layerId,
        type: "line",
        source: sourceId,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": p.leg.routeColor
            ? `#${p.leg.routeColor}`
            : MODE_COLORS[p.leg.mode],
          "line-width": p.leg.mode === "WALK" ? 3 : 5,
          "line-opacity": opacity,
          ...(p.leg.mode === "WALK" ? { "line-dasharray": [2, 2] } : {}),
        },
      },
      beforeId,
    );
  } else {
    (src as maplibregl.GeoJSONSource).setData(geojson);
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, "line-opacity", opacity);
      // If the stops layer mounted after this leg's first enqueue, the
      // initial `addLayer` ran with `beforeId=undefined` (so the leg now
      // sits above stops). Re-position so the first user-tap after stops
      // appear lands on a marker, not the polyline. Note: this only
      // catches legs that get re-enqueued; a leg that paints once and
      // is never updated again will stay above stops if stops mount
      // afterwards. In practice geometry-resolve and RT updates re-
      // enqueue most legs frequently; the static-leg case is a known
      // residual gap not addressed here.
      if (map.getLayer(STOPS_LAYER)) map.moveLayer(layerId, STOPS_LAYER);
    }
  }
}

function paintOpacity(statusOpacity: number, g: LegGeometryResult): number {
  const dim = g.pending || g.partial || g.source === "endpoints";
  return dim ? statusOpacity * pendingOpacityMultiplier() : statusOpacity;
}

export function __resetScheduler(): void {
  if (frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
  pendingTokenValue = null;
  singletonMap = null;
  pending.clear();
}
