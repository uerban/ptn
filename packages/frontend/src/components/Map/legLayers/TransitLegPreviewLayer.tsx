import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type * as maplibregl from "maplibre-gl";
import type { Leg, LegStatus } from "@pt/shared";
import { useGtfsDataStore } from "../../../stores/gtfsDataStore.ts";
import { db } from "../../../db/index.ts";

interface Props {
  map: maplibregl.Map;
  leg: Leg;
  index: number;
  status: LegStatus;
}

const SOURCE_PREFIX = "guidance-leg-preview-";
const LAYER_PREFIX = "guidance-leg-preview-layer-";
// Mirrors the constant in `rafScheduler.ts`; duplicated to avoid a
// circular module dep between the leg-layer files.
const MAIN_LEG_LAYER_PREFIX = "guidance-leg-layer-";
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

// 0.45 (vs the 0.35 originally proposed) clears WCAG 1.4.11 non-text 3:1
// against the default light basemap for the bus/metro modes; pairs with
// dotted (not dashed) so the preview is unambiguously distinct from the
// `[2, 2]` dashed WALK paint.
const PREVIEW_OPACITY = 0.45;

/**
 * Renders a faded "context" extension around a transit leg:
 *   - current leg → one stop before board + one stop after alight
 *   - upcoming leg → one stop before board only
 *
 * Drawn as a separate map layer per leg, so removing it on status change
 * (e.g. `current → completed`) doesn't disturb the main `TransitLegLayer`.
 * Geometry is a stop-chord (board±1 / alight±1) — `shapes.txt` polylines
 * lack `shape_dist_traveled` in our pipeline today, so slicing the road-
 * following shape at exact stop boundaries isn't reliable. The preview is
 * a deliberately faded teaser, not a precise route segment.
 */
export function TransitLegPreviewLayer({ map, leg, index, status }: Props) {
  const showPre = status === "current" || status === "upcoming";
  const showPost = status === "current";
  const enabled =
    (showPre || showPost) &&
    leg.routeId !== undefined &&
    leg.boardStopIdx !== undefined &&
    leg.alightStopIdx !== undefined;

  const raptorIndex = useGtfsDataStore((s) => s.raptorIndex);

  const stopIds: { pre?: string; post?: string } = (() => {
    if (!enabled) return {};
    const boardIdx = leg.boardStopIdx ?? 0;
    const alightIdx = leg.alightStopIdx ?? 0;
    // PatternMode On: resolve neighbors from the pattern stop sequence carried
    // on the leg. This is correct for branch/variant stops and avoids the lossy
    // routeIdToIdx lookup (one route_id → many patterns under PatternMode).
    if (leg.patternStopIds) {
      const seq = leg.patternStopIds;
      return {
        pre: showPre && boardIdx > 0 ? seq[boardIdx - 1] : undefined,
        post: showPost && alightIdx + 1 < seq.length ? seq[alightIdx + 1] : undefined,
      };
    }
    // PatternMode Off / legacy: fall back to the in-memory canonical route.
    if (!raptorIndex || !leg.routeId) return {};
    const routeIdx = raptorIndex.routeIdToIdx.get(leg.routeId);
    if (routeIdx === undefined) return {};
    const route = raptorIndex.routes[routeIdx];
    return {
      pre: showPre && boardIdx > 0 ? route.stopIds[boardIdx - 1] : undefined,
      post:
        showPost && alightIdx + 1 < route.stopIds.length
          ? route.stopIds[alightIdx + 1]
          : undefined,
    };
  })();

  const preStopId = stopIds.pre;
  const postStopId = stopIds.post;
  const neighbourIds = [preStopId, postStopId].filter(
    (s): s is string => !!s,
  );
  // The two stop IDs are always disjoint (pre is at boardStopIdx-1, post
  // at alightStopIdx+1, with board <= alight) — but use a position-aware
  // key (`pre|post`) anyway so the live-query never aliases two different
  // (pre, post) tuples that happen to share one ID.
  const neighbourKey = `${preStopId ?? ""}|${postStopId ?? ""}`;
  const neighbours = useLiveQuery(
    async () => {
      if (neighbourIds.length === 0) return [];
      return db.gtfsStops.bulkGet(neighbourIds);
    },
    [neighbourKey],
  );

  // Resolve neighbour coords outside the effect so the effect can depend
  // on the four primitive lon/lat values (stable across Dexie emissions
  // that don't change content) instead of the `neighbours` array
  // reference (which Dexie re-emits on every write to gtfsStops).
  const preLoc = preStopId
    ? neighbours?.find((s) => s?.id === preStopId)
    : undefined;
  const postLoc = postStopId
    ? neighbours?.find((s) => s?.id === postStopId)
    : undefined;
  const preLon = preLoc?.lon;
  const preLat = preLoc?.lat;
  const postLon = postLoc?.lon;
  const postLat = postLoc?.lat;

  useEffect(() => {
    const sourceId = `${SOURCE_PREFIX}${index}`;
    const layerId = `${LAYER_PREFIX}${index}`;
    const cleanup = () => {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    };

    if (!enabled) {
      cleanup();
      return cleanup;
    }

    const features: GeoJSON.Feature[] = [];
    if (preLon !== undefined && preLat !== undefined) {
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [preLon, preLat],
            [leg.from.location.lon, leg.from.location.lat],
          ],
        },
        properties: { kind: "pre" },
      });
    }
    if (postLon !== undefined && postLat !== undefined) {
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [leg.to.location.lon, leg.to.location.lat],
            [postLon, postLat],
          ],
        },
        properties: { kind: "post" },
      });
    }

    if (features.length === 0) {
      cleanup();
      return cleanup;
    }

    const data: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
    const color = leg.routeColor ? `#${leg.routeColor}` : MODE_COLORS[leg.mode];
    // Insert below the main leg layer so the preview never sits on top of
    // the line the user is actually riding. The main leg layer is added
    // through `rafScheduler` (deferred to next rAF), so on first mount the
    // layer may not exist yet — fall back to the stops layer, then to the
    // top of the stack. Once both are mounted, the next status change
    // re-runs this effect and the preview moves underneath the main leg.
    const beforeId = map.getLayer(`${MAIN_LEG_LAYER_PREFIX}${index}`)
      ? `${MAIN_LEG_LAYER_PREFIX}${index}`
      : map.getLayer(STOPS_LAYER)
        ? STOPS_LAYER
        : undefined;

    const existing = map.getSource(sourceId);
    if (existing) {
      (existing as maplibregl.GeoJSONSource).setData(data);
      if (map.getLayer(layerId)) {
        map.setPaintProperty(layerId, "line-color", color);
      }
    } else {
      map.addSource(sourceId, { type: "geojson", data });
      map.addLayer(
        {
          id: layerId,
          type: "line",
          source: sourceId,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": color,
            "line-width": 3,
            "line-opacity": PREVIEW_OPACITY,
            // Tight dotted pattern (with a round line-cap rendering each
            // "dot" as a small disc) — visually distinct from WALK's
            // [2, 2] long dashes so a faded transit preview doesn't read
            // as a walking segment.
            "line-dasharray": [0.4, 2],
          },
        },
        beforeId,
      );
    }

    return cleanup;
  }, [
    map,
    index,
    enabled,
    preLon,
    preLat,
    postLon,
    postLat,
    leg.from.location.lon,
    leg.from.location.lat,
    leg.to.location.lon,
    leg.to.location.lat,
    leg.routeColor,
    leg.mode,
  ]);

  return null;
}
