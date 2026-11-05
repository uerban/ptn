import { useEffect, useRef } from "react";
import maplibregl from "../../map/maplibre.ts";
import type { Itinerary } from "@pt/shared";
import { TRANSFER_BADGE_THRESHOLD_S } from "@pt/shared/constants";
import { useRtStore } from "../../stores/rtStore.ts";

interface TransferBadgeProps {
  map: maplibregl.Map | null;
  itinerary: Itinerary | null;
  currentLegIndex: number;
}

function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function TransferBadge({
  map,
  itinerary,
  currentLegIndex,
}: TransferBadgeProps) {
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Clean up old markers
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    if (intervalRef.current) clearInterval(intervalRef.current);

    if (!map || !itinerary) return;

    // Find transfer points: where one leg ends and a transit leg begins
    const rtStore = useRtStore.getState();
    const transfers: { location: [number, number]; departureTime: string; delaySeconds: number; index: number }[] = [];
    for (let i = currentLegIndex + 1; i < itinerary.legs.length; i++) {
      const leg = itinerary.legs[i];
      if (leg.mode !== "WALK" && leg.mode !== "BIKE" && leg.mode !== "SCOOTER") {
        const rtDelay = leg.tripId ? rtStore.getTripDelay(leg.tripId) : null;
        transfers.push({
          location: [leg.from.location.lon, leg.from.location.lat],
          departureTime: leg.departureTime,
          delaySeconds: rtDelay?.delaySeconds ?? 0,
          index: i,
        });
      }
    }

    if (transfers.length === 0) return;

    // Create marker elements
    const markerEls: { el: HTMLDivElement; departureTime: string; delaySeconds: number }[] = [];
    for (const transfer of transfers) {
      const el = document.createElement("div");
      el.className = "transfer-badge";
      el.style.cssText =
        "background:#1e40af;color:white;font-size:11px;font-weight:700;padding:2px 6px;border-radius:8px;white-space:nowrap;pointer-events:none;";

      const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat(transfer.location)
        .addTo(map);

      markersRef.current.push(marker);
      markerEls.push({ el, departureTime: transfer.departureTime, delaySeconds: transfer.delaySeconds });
    }

    // Update countdown text
    function updateCountdowns() {
      const now = Date.now();
      for (const { el, departureTime, delaySeconds } of markerEls) {
        // Adjust departure time by RT delay
        const adjustedDeparture = new Date(departureTime).getTime() + delaySeconds * 1000;
        const secondsRemaining = Math.max(0, Math.round((adjustedDeparture - now) / 1000));
        if (secondsRemaining > TRANSFER_BADGE_THRESHOLD_S) {
          el.style.display = "none";
        } else {
          el.style.display = "";
          el.textContent = formatCountdown(secondsRemaining);
        }
      }
    }

    updateCountdowns();
    intervalRef.current = setInterval(updateCountdowns, 1000);

    return () => {
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [map, itinerary, currentLegIndex]);

  return null;
}
