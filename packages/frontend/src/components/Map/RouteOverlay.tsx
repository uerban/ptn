import { Fragment, useEffect, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import type { Itinerary, LegStatus } from "@pt/shared";
import { TransitLegLayer } from "./legLayers/TransitLegLayer.tsx";
import { TransitLegPreviewLayer } from "./legLayers/TransitLegPreviewLayer.tsx";
import { WalkLegLayer } from "./legLayers/WalkLegLayer.tsx";

interface RouteOverlayProps {
  map: maplibregl.Map | null;
  itinerary: Itinerary | null;
  legStatuses: LegStatus[];
}

const STATUS_OPACITY: Record<LegStatus, number> = {
  completed: 0.3,
  current: 1.0,
  upcoming: 0.7,
  future: 0.4,
};

const LAYER_PREFIX = "guidance-leg-layer-";
const LEG_LAYER_PREFIXES = ["guidance-leg-preview-layer-", LAYER_PREFIX] as const;
const STOPS_CLUSTER_LAYER = "stops-clusters";

const isLegLayer = (id: string): boolean => LEG_LAYER_PREFIXES.some((p) => id.startsWith(p));

/**
 * Lift the leg layers back above the basemap after it was merged in later.
 *
 * The external basemap is added to the running map before `stops-clusters`
 * once it loads (styleBuilder `mergeCartoIntoRunningMap`). Legs drawn before
 * that — a guidance session started before the basemap arrived, or after the
 * one-time detailed-map prompt — end up under its opaque background and the
 * route vanishes while its layers still exist, so the missing-layer check
 * never fires. Whenever a non-leg layer sits above a leg layer below the stop
 * clusters, move every leg layer, in order, to just below the clusters. Once
 * moved nothing foreign sits above them, so the `styledata` this fires
 * returns without moving again.
 */
export function reanchorLegLayers(map: maplibregl.Map): void {
  const layers = map.getStyle()?.layers ?? [];
  const clusterIdx = layers.findIndex((l) => l.id === STOPS_CLUSTER_LAYER);
  if (clusterIdx === -1) return;
  const below = layers.slice(0, clusterIdx);
  const firstLeg = below.findIndex((l) => isLegLayer(l.id));
  if (firstLeg === -1) return;
  const buried = below.slice(firstLeg + 1).some((l) => !isLegLayer(l.id));
  if (!buried) return;
  for (const layer of below) {
    if (isLegLayer(layer.id)) map.moveLayer(layer.id, STOPS_CLUSTER_LAYER);
  }
}

/**
 * RouteOverlay: delegates to per-mode leg-layer children.
 *
 * One TransitLegLayer or WalkLegLayer per leg, keyed by index. Each child
 * owns its own source/layer bookkeeping via the rafScheduler singleton, so
 * this component is purely compositional.
 *
 * Preserved behaviour: listens for `styledata` to detect full theme swaps
 * (which wipe all layers via map.setStyle). When detected, bumps a revision
 * counter that is folded into each child's key, forcing a remount so the
 * scheduler re-adds source + layer on the new style.
 */
export function RouteOverlay({ map, itinerary, legStatuses }: RouteOverlayProps) {
  const [styleRev, setStyleRev] = useState(0);

  // Listen for full style swaps (e.g. theme toggle) which wipe all layers.
  // Detect by checking whether any of our leg layers still exist after the
  // styledata event. Only bumps revision when layers are actually missing,
  // avoiding a feedback loop with the scheduler's own addLayer calls.
  //
  // Guarded by `isStyleLoaded()`: MapLibre fires `styledata` multiple times
  // during a swap, and in the early firings `map.style` can still be
  // undefined — calling `getLayer` there throws
  // `can't access property "getLayer", this.style is undefined`, surfaces
  // via window.onerror, and (critically) prevents the `setStyleRev` bump,
  // so TransitLegLayer children never remount after the new style lands
  // and the shape layers disappear for good. Deferring to the next
  // `styledata` (which fires once the style is ready) keeps the detection
  // correct and prevents the crash.
  useEffect(() => {
    if (!map || !itinerary || itinerary.legs.length === 0) return;
    const onStyleData = () => {
      if (!map.isStyleLoaded()) return;
      const hasAny = itinerary.legs.some((_, i) =>
        map.getLayer(`${LAYER_PREFIX}${i}`),
      );
      if (!hasAny) {
        setStyleRev((r) => r + 1);
        return;
      }
      reanchorLegLayers(map);
    };
    map.on("styledata", onStyleData);
    return () => {
      map.off("styledata", onStyleData);
    };
  }, [map, itinerary]);

  if (!map || !itinerary) return null;

  return (
    <>
      {itinerary.legs.map((leg, i) => {
        const status = legStatuses[i] ?? "future";
        const statusOpacity = STATUS_OPACITY[status];
        if (leg.mode === "WALK") {
          // Draws the straight line at once and swaps in the walk-graph path
          // when it resolves (or keeps the line for a city without a graph).
          return (
            <WalkLegLayer
              key={`leg-${i}-${styleRev}`}
              map={map}
              leg={leg}
              index={i}
              statusOpacity={statusOpacity}
            />
          );
        }
        // Transit leg — main shape + faded ±1-stop preview around the
        // active leg (current = pre + post; upcoming = pre only). The
        // preview layer mounts unconditionally and self-disables for
        // `completed`/`future` statuses by removing its source/layer in
        // its own cleanup; its `beforeId` references the main leg's layer
        // so the preview always renders below the leg you're actually on.
        return (
          <Fragment key={`leg-${i}-${styleRev}`}>
            <TransitLegLayer
              map={map}
              leg={leg}
              index={i}
              statusOpacity={statusOpacity}
            />
            <TransitLegPreviewLayer
              map={map}
              leg={leg}
              index={i}
              status={status}
            />
          </Fragment>
        );
      })}
    </>
  );
}
