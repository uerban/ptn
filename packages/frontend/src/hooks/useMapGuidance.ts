import { useEffect, useRef, useCallback } from "react";
import maplibregl from "../map/maplibre.ts";
import type { Itinerary, LatLon } from "@pt/shared";
import { AUTO_FOLLOW_PADDING_PX } from "@pt/shared/constants";
import { decodePolyline } from "../utils/polyline.ts";
import { bearing as computeBearing, progressAlongLine } from "../utils/geo.ts";
import { useGuidanceStore } from "../stores/guidanceStore.ts";

/**
 * Map interaction for guided navigation:
 * - zoomToLeg(index): fits map to a specific leg's bounding box
 * - Auto-follows user position during walking legs
 * - Rider mode: orients map in travel direction with 45-degree pitch
 */
export function useMapGuidance(
  map: maplibregl.Map | null,
  itinerary: Itinerary | null,
  userPosition: LatLon | null,
  vehicleHeading?: number | null
) {
  const autoFollowRef = useRef(true);
  const phase = useGuidanceStore((s) => s.phase);
  const currentLegIndex = useGuidanceStore((s) => s.currentLegIndex);

  const zoomToLeg = useCallback(
    (legIndex: number) => {
      if (!map || !itinerary) return;
      const leg = itinerary.legs[legIndex];
      if (!leg) return;

      autoFollowRef.current = false;

      const points = leg.polyline
        ? decodePolyline(leg.polyline)
        : [leg.from.location, leg.to.location];

      if (points.length === 0) return;

      const bounds = new maplibregl.LngLatBounds();
      for (const p of points) {
        bounds.extend([p.lon, p.lat]);
      }

      map.fitBounds(bounds, {
        padding: AUTO_FOLLOW_PADDING_PX,
        maxZoom: 17,
        duration: 500,
      });
    },
    [map, itinerary]
  );

  // Auto-follow during walking legs
  useEffect(() => {
    if (
      !map ||
      !itinerary ||
      !userPosition ||
      phase !== "navigating" ||
      !autoFollowRef.current
    )
      return;

    const currentLeg = itinerary.legs[currentLegIndex];
    if (!currentLeg) return;

    const isWalking =
      currentLeg.mode === "WALK" ||
      currentLeg.mode === "BIKE" ||
      currentLeg.mode === "SCOOTER";

    if (isWalking) {
      map.easeTo({
        center: [userPosition.lon, userPosition.lat],
        duration: 300,
      });
    }
  }, [map, itinerary, userPosition, phase, currentLegIndex]);

  // Re-enable auto-follow when leg changes
  useEffect(() => {
    autoFollowRef.current = true;
  }, [currentLegIndex]);

  // Disable auto-follow on user interaction
  useEffect(() => {
    if (!map) return;

    const disableFollow = () => {
      autoFollowRef.current = false;
    };

    map.on("dragstart", disableFollow);
    map.on("zoomstart", disableFollow);

    return () => {
      map.off("dragstart", disableFollow);
      map.off("zoomstart", disableFollow);
    };
  }, [map]);

  // Rider mode: orient map in travel direction
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    if (!map || !userPosition) return;

    if (phase === "riderMode") {
      // Compute bearing from vehicle heading (RT data) or polyline direction
      let mapBearing = 0;
      if (vehicleHeading != null) {
        mapBearing = vehicleHeading;
      } else if (itinerary) {
        const leg = itinerary.legs[currentLegIndex];
        if (leg?.polyline) {
          const line = decodePolyline(leg.polyline);
          const progress = progressAlongLine(userPosition, line);
          // Find the segment the user is on and compute direction
          const idx = Math.min(
            Math.floor(progress * (line.length - 1)),
            line.length - 2
          );
          if (idx >= 0 && idx < line.length - 1) {
            mapBearing = computeBearing(line[idx], line[idx + 1]);
          }
        }
      }

      map.easeTo({
        center: [userPosition.lon, userPosition.lat],
        bearing: mapBearing,
        pitch: 45,
        duration: 500,
      });
    }

    // Reset bearing when exiting rider mode
    if (prevPhaseRef.current === "riderMode" && phase !== "riderMode") {
      map.easeTo({
        bearing: 0,
        pitch: 0,
        duration: 500,
      });
    }

    prevPhaseRef.current = phase;
  }, [map, userPosition, phase, vehicleHeading, itinerary, currentLegIndex]);

  return { zoomToLeg };
}
