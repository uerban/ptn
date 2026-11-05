import { useWatchPosition } from "../../hooks/useWatchPosition.ts";
import { UserPositionMarker } from "../Map/UserPositionMarker.tsx";
import { useEffect, useRef, useState } from "react";
import type { BaseEndpoint, LatLon } from "@pt/shared";
import maplibregl from "../../map/maplibre.ts";
import { TransitMap } from "../Map/TransitMap.tsx";
import { MapTapActionSheet } from "../Map/MapTapActionSheet.tsx";
import { MicromapLayer } from "../Map/MicromapLayer.tsx";
import { GtfsCorridorLayer } from "../Map/GtfsCorridorLayer.tsx";
import { useStopPreloader } from "../../hooks/useStopPreloader.ts";
import { useStopStore } from "../../stores/stopStore.ts";
import { useMapTapStore } from "../../stores/mapTapStore.ts";
import { useTranslation } from "../../i18n/index.ts";

/** Search owns the draft throughout this modal; raw map coordinates stay in mapTapStore. */
export function SearchMapPicker({ field, center, onSelect, onCancel }: {
  field: "from" | "to";
  center?: LatLon;
  onSelect: (endpoint: BaseEndpoint) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const location = useWatchPosition(true);
  useStopPreloader(null);
  const stops = useStopStore(s => s.stops);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const rawTap = useMapTapStore(s => s.rawTap);
  const container = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = container.current;
    element?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); cancelRef.current(); }
      if (event.key === "Tab" && element) {
        const buttons = Array.from(element.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"], a[href]'))
          .filter(node => node.getClientRects().length > 0);
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first?.focus(); }
      }
    };
    element?.addEventListener("keydown", onKeyDown);
    return () => {
      element?.removeEventListener("keydown", onKeyDown);
      useMapTapStore.getState().clear();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (!map || !rawTap) return;
    const marker = new maplibregl.Marker().setLngLat([rawTap.lon, rawTap.lat]).addTo(map);
    return () => { marker.remove(); };
  }, [map, rawTap]);

  useEffect(() => {
    if (rawTap) container.current?.querySelector<HTMLElement>('[role="dialog"]')?.querySelector<HTMLElement>("button")?.focus();
    else container.current?.focus();
  }, [rawTap]);

  function dropPin(point: LatLon) { useMapTapStore.getState().emitTap(point.lat, point.lon); }

  return <div ref={container} role="dialog" aria-modal="true" aria-labelledby="search-map-title" tabIndex={-1}
    className="absolute inset-0 z-40 flex flex-col min-h-0 bg-surface focus:outline-none">
    <header className="shrink-0 flex items-start justify-between gap-3 p-3 bg-surface-raised border-b border-divider">
      <div><h2 id="search-map-title" className="text-sm font-semibold text-fg">
        {field === "from" ? t("search.map_origin", "Choose starting point on map") : t("search.map_destination", "Choose destination on map")}
      </h2><p className="text-xs text-fg-muted mt-1">{t("search.map_instructions", "Tap the map to drop a pin, then confirm the place.")}</p></div>
      <button type="button" className="min-h-11 px-2 text-sm text-accent" onClick={onCancel}>{t("search.map_cancel", "Cancel")}</button>
    </header>
    <div className="relative flex-1 min-h-0">
      <TransitMap center={center} stops={stops} onMapReady={setMap} onMapClick={dropPin} onStopClick={stop => dropPin(stop.location)} />
      {map && <UserPositionMarker map={map} position={location.position} heading={location.heading} accuracy={location.accuracy} />}
      <MicromapLayer map={map} />
      <GtfsCorridorLayer map={map} />
      <MapTapActionSheet picker={{ role: field === "from" ? "origin" : "destination", onSelect }} />
    </div>
    {!rawTap && <button type="button" disabled={!map} className="shrink-0 min-h-11 px-4 py-3 text-sm text-accent border-t border-divider disabled:opacity-50"
      onClick={() => { if (map) { const point = map.getCenter(); dropPin({ lat: point.lat, lon: point.lng }); } }}>
      {t("search.map_use_centre", "Choose map centre")}
    </button>}
  </div>;
}
