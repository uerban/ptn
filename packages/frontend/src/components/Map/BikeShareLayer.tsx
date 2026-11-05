import { useEffect, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { useBikeShareStore } from "../../stores/bikeShareStore.ts";
import {
  BIKE_CIRCLE_COLOR,
  BIKE_CIRCLE_LAYER,
  BIKE_LABEL_COLOR,
  BIKE_LABEL_LAYER,
  BIKE_SOURCE,
  stationsToFeatures,
} from "./bikeShareFeatures.ts";
import { labelFontstack } from "../../map/styleBuilder.ts";

interface BikeShareLayerProps {
  map: maplibregl.Map | null;
}

// Layer ids the bike markers must render BELOW: route overlays (guidance
// legs + previews, line view) and — matching the leg layers' own ordering —
// the interactive stop layers, so stop taps keep landing on stops. Strings
// are duplicated from their owners (rafScheduler / TransitLegPreviewLayer /
// LineRouteOverlay / TransitMap), same as rafScheduler does, to avoid
// circular module deps between map components.
const ABOVE_LAYER_PREFIXES = [
  "guidance-leg-preview-layer-",
  "guidance-leg-layer-",
  "line-route-line",
] as const;
const STOPS_CLUSTER_LAYER = "stops-clusters";
const STOPS_DOT_LAYER = "stops-dot";
/** Interactive stop layers that must win a tap shared with a bike circle. */
const STOP_TAP_LAYERS = [STOPS_CLUSTER_LAYER, STOPS_DOT_LAYER] as const;

/**
 * First currently-mounted layer the bike layer must slot under, for use as
 * `addLayer`'s `beforeId`. The actual style order is authoritative: guidance
 * overlays normally sit below the stop layers, while `LineRouteOverlay`
 * appends `line-route-line` above them. Picking the first matching landmark
 * keeps bikes below both arrangements. With no landmark, `undefined` appends
 * on top — later overlay/stop layers then mount above us by their own rules.
 */
export function findBeforeId(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  const anchor = layers.find(
    (layer) =>
      layer.id === STOPS_CLUSTER_LAYER ||
      ABOVE_LAYER_PREFIXES.some((prefix) => layer.id.startsWith(prefix)),
  );
  return anchor?.id ??
    (map.getLayer(STOPS_CLUSTER_LAYER) ? STOPS_CLUSTER_LAYER : undefined);
}

const isOverlayLayer = (id: string): boolean =>
  ABOVE_LAYER_PREFIXES.some((p) => id.startsWith(p));

/**
 * Re-anchor the bike layers after an incremental basemap merge.
 *
 * `mergeCartoIntoRunningMap` (styleBuilder.ts) inserts every external
 * basemap layer before `stops-clusters` — the same anchor the bike layers
 * use when no route overlay is mounted. So when the Carto basemap finishes
 * loading AFTER the bike layer mounted, its opaque layers land between the
 * bike markers and the stop clusters and hide the bikes. The merge never
 * removes our layers, so the missing-layer `styleRev` path can't catch it.
 *
 * Instead, on every style mutation we look for foreign (non-route-overlay)
 * layers sitting between the bike label and the stop clusters and hop the
 * bike pair back up with `moveLayer` — the same recovery `rafScheduler`
 * uses for its own stops-anchor race. The bikes slot in directly below the
 * lowest route-overlay layer that sits ABOVE every foreign layer in that
 * window (bikes render below route lines), else directly below the
 * clusters. A route overlay that is itself buried under a foreign layer is
 * NOT a valid anchor: rafScheduler only repairs a leg when it gets
 * re-enqueued, which a static leg may never be, so waiting on it would
 * leave the bikes buried with it. The bikes hop over such an overlay —
 * briefly rendering above the route line — and when rafScheduler does
 * repair it, its moveLayer fires `styledata` and the run below restores
 * bikes-under-overlay ordering. After our own move the window holds no
 * foreign layers, so the re-entrant `styledata` returns early — never a
 * loop.
 */
export function reanchorAboveBasemap(map: maplibregl.Map): void {
  const layers = map.getStyle()?.layers ?? [];
  const labelIdx = layers.findIndex((l) => l.id === BIKE_LABEL_LAYER);
  const clusterIdx = layers.findIndex((l) => l.id === STOPS_CLUSTER_LAYER);
  if (labelIdx === -1 || clusterIdx === -1) return;
  // `line-route-line` is appended above the stop layers. Older anchor logic
  // could therefore place bikes above `stops-clusters` when the layer was
  // enabled during line view. Repair that state before handling basemap races.
  if (clusterIdx < labelIdx) {
    const anchor = findBeforeId(map);
    if (anchor !== undefined) {
      map.moveLayer(BIKE_CIRCLE_LAYER, anchor);
      map.moveLayer(BIKE_LABEL_LAYER, anchor);
    }
    return;
  }
  const between = layers.slice(labelIdx + 1, clusterIdx);
  // Topmost foreign layer in the window (reverse scan: lib is ES2022, no
  // findLastIndex). Everything above it in the window is a route overlay.
  let lastForeign = -1;
  for (let i = between.length - 1; i >= 0; i--) {
    if (!isOverlayLayer(between[i].id)) {
      lastForeign = i;
      break;
    }
  }
  if (lastForeign === -1) return; // only route overlays above us — anchored
  const anchor = between[lastForeign + 1]?.id ?? STOPS_CLUSTER_LAYER;
  map.moveLayer(BIKE_CIRCLE_LAYER, anchor);
  map.moveLayer(BIKE_LABEL_LAYER, anchor);
}

/**
 * MapLibre rendering half of the bike-share layer: one GeoJSON source, a
 * color-bucketed circle layer, and a count symbol layer, driven by
 * `bikeShareStore` (feature building lives in `bikeShareFeatures.ts`).
 *
 * Three effects, deliberately split:
 * - a `styledata` listener detecting full style swaps (theme toggle wipes
 *   all custom layers — same pattern as `RouteOverlay`), bumping `styleRev`;
 * - a lifecycle effect (keyed map/enabled/styleRev) owning source, layers
 *   and handlers — mounted once per session, torn down on unmount/toggle-off;
 * - a data effect that only calls `setData`, so the 60 s poll updates the
 *   source in place instead of tearing down and re-adding everything.
 */
export function BikeShareLayer({ map }: BikeShareLayerProps) {
  const enabled = useBikeShareStore((s) => s.enabled);
  const stations = useBikeShareStore((s) => s.stations);
  const [styleRev, setStyleRev] = useState(0);

  // Full style swaps (map.setStyle on theme change) silently drop our
  // source and layers. Detect layers gone missing after `styledata` and
  // bump the revision so the lifecycle effect re-adds them on the new
  // style. `isStyleLoaded` guard per RouteOverlay: early `styledata`
  // firings during a swap can precede a usable style. When the layers
  // survived the mutation, check the other failure mode instead: an
  // incremental basemap merge slotting opaque layers above the bikes.
  useEffect(() => {
    if (!map || !enabled) return;
    const onStyleData = () => {
      if (!map.isStyleLoaded()) return;
      if (!map.getLayer(BIKE_CIRCLE_LAYER)) {
        setStyleRev((r) => r + 1);
        return;
      }
      reanchorAboveBasemap(map);
    };
    map.on("styledata", onStyleData);
    return () => {
      map.off("styledata", onStyleData);
    };
  }, [map, enabled]);

  // Lifecycle: source + layers + interaction handlers.
  useEffect(() => {
    if (!map || !enabled) return;

    // Circle tap → station sheet (via `bikeShareStore.selectStation`). Stops
    // render above bikes on purpose, so when the tap ALSO hits an interactive
    // stop layer the stop handler owns it and we bail — a bike sheet must
    // never shadow a stop popup.
    const onCircleClick = (e: maplibregl.MapLayerMouseEvent) => {
      const stopLayers = STOP_TAP_LAYERS.filter((id) => map.getLayer(id));
      if (
        stopLayers.length > 0 &&
        map.queryRenderedFeatures(e.point, { layers: [...stopLayers] }).length > 0
      ) {
        return;
      }
      const stationId = e.features?.[0]?.properties?.stationId;
      if (typeof stationId === "string") {
        useBikeShareStore.getState().selectStation(stationId);
      }
    };
    const onMouseEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onMouseLeave = () => {
      map.getCanvas().style.cursor = "";
    };

    const removeLayers = () => {
      if (map.getLayer(BIKE_LABEL_LAYER)) map.removeLayer(BIKE_LABEL_LAYER);
      if (map.getLayer(BIKE_CIRCLE_LAYER)) map.removeLayer(BIKE_CIRCLE_LAYER);
      if (map.getSource(BIKE_SOURCE)) map.removeSource(BIKE_SOURCE);
    };

    removeLayers(); // drop any stale half-state before adding
    map.addSource(BIKE_SOURCE, {
      type: "geojson",
      // Current snapshot without depending on `stations` — data updates are
      // the data effect's job.
      data: stationsToFeatures(useBikeShareStore.getState().stations),
    });

    const beforeId = findBeforeId(map);
    map.addLayer(
      {
        id: BIKE_CIRCLE_LAYER,
        type: "circle",
        source: BIKE_SOURCE,
        paint: {
          "circle-radius": 9,
          "circle-color": BIKE_CIRCLE_COLOR,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
          // Opaque bucket colors make label contrast deterministic.
          "circle-opacity": 1,
        },
      },
      beforeId,
    );
    // Same beforeId keeps the labels directly above their circles while
    // both stay below the route-overlay/stop layers.
    map.addLayer(
      {
        id: BIKE_LABEL_LAYER,
        type: "symbol",
        source: BIKE_SOURCE,
        layout: {
          // "" for unknown counts — draws nothing (never a fake 0).
          "text-field": ["get", "label"],
          "text-font": [...labelFontstack()],
          "text-size": 11,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": BIKE_LABEL_COLOR,
        },
      },
      beforeId,
    );

    map.on("click", BIKE_CIRCLE_LAYER, onCircleClick);
    map.on("mouseenter", BIKE_CIRCLE_LAYER, onMouseEnter);
    map.on("mouseleave", BIKE_CIRCLE_LAYER, onMouseLeave);

    return () => {
      map.off("click", BIKE_CIRCLE_LAYER, onCircleClick);
      map.off("mouseenter", BIKE_CIRCLE_LAYER, onMouseEnter);
      map.off("mouseleave", BIKE_CIRCLE_LAYER, onMouseLeave);
      removeLayers();
    };
  }, [map, enabled, styleRev]);

  // Data: poll results update the source in place — never a layer teardown.
  useEffect(() => {
    if (!map || !enabled) return;
    const source = map.getSource(BIKE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData(stationsToFeatures(stations));
  }, [map, enabled, stations, styleRev]);

  return null;
}
