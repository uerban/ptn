import type { PrivacyPolicy, StopWithLines } from "@pt/shared";
import { isOptionalStorageEnabledNow } from "../services/privacyChoices.ts";
import { getPolicy, usePrivacyStore } from "../stores/privacyStore.ts";
import { mapViewportItem } from "../services/sealedLocalStorage.ts";
import { canonicalCityId } from "./cityId.ts";
import { haversineDistance } from "./geo.ts";

export { MAP_VIEWPORT_STORAGE_KEY } from "../services/privacyStorageKeys.ts";

export interface SavedViewport {
  cityId: string;
  lat: number;
  lon: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

type PersistedViewportMode = Exclude<
  PrivacyPolicy["viewportPersistence"],
  "off"
>;

interface PersistedViewport extends SavedViewport {
  privacyMode?: PersistedViewportMode;
  version?: 1;
}

const MIN_ZOOM = 0;
const MAX_ZOOM = 24;
const MAX_PITCH = 60;
const EARTH_LAT_METERS_PER_DEG = 111_320;

const MODE_RANK: Record<PrivacyPolicy["viewportPersistence"], number> = {
  raw: 0,
  "snap-centroid": 1,
  "rounded-50m": 2,
  "rounded-100m": 3,
  off: 4,
};

// The stored areas (one per city) are sealed with the install key as one value;
// `mapViewportItem` holds the decrypted copy loaded at start-up so the map can
// read it synchronously.
function clearStoredViewport(): void {
  mapViewportItem.remove();
}

function isPersistedMode(value: unknown): value is PersistedViewportMode {
  return (
    value === "raw" ||
    value === "snap-centroid" ||
    value === "rounded-50m" ||
    value === "rounded-100m"
  );
}

function parseStoredViewport(raw: string): PersistedViewport | null {
  try {
    const v = JSON.parse(raw) as Partial<PersistedViewport>;
    if (
      typeof v.cityId !== "string" ||
      v.cityId.length === 0 ||
      typeof v.lat !== "number" ||
      typeof v.lon !== "number" ||
      typeof v.zoom !== "number" ||
      !Number.isFinite(v.lat) ||
      !Number.isFinite(v.lon) ||
      !Number.isFinite(v.zoom) ||
      Math.abs(v.lat) > 90 ||
      Math.abs(v.lon) > 180 ||
      v.zoom < MIN_ZOOM ||
      v.zoom > MAX_ZOOM ||
      (v.privacyMode !== undefined && !isPersistedMode(v.privacyMode))
    ) {
      return null;
    }
    const pitch = Number.isFinite(v.pitch) ? (v.pitch as number) : 0;
    const bearing = Number.isFinite(v.bearing) ? (v.bearing as number) : 0;
    return {
      cityId: canonicalCityId(v.cityId),
      lat: v.lat,
      lon: v.lon,
      zoom: v.zoom,
      bearing: ((bearing % 360) + 360) % 360,
      pitch: Math.min(MAX_PITCH, Math.max(0, pitch)),
      privacyMode: v.privacyMode,
      version: v.version,
    };
  } catch {
    return null;
  }
}

function storedMode(v: PersistedViewport): PersistedViewportMode {
  // Viewports written before this privacy contract carried exact coordinates.
  return v.privacyMode ?? "raw";
}

interface ViewportCollection {
  lastCityId?: string;
  viewports: Map<string, PersistedViewport>;
}

function readViewports(): ViewportCollection {
  const empty = {viewports: new Map<string, PersistedViewport>()};
  const raw = mapViewportItem.get();
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw);
    const rows = value?.version === 2 && Array.isArray(value.viewports) ? value.viewports : [value];
    const viewports = new Map<string, PersistedViewport>();
    for (const row of rows) {
      const parsed = parseStoredViewport(JSON.stringify(row));
      if (parsed) viewports.set(parsed.cityId, parsed);
    }
    const legacy = parseStoredViewport(raw);
    const lastCityId = value?.version === 2 ? value.lastCityId : legacy?.cityId;
    return {viewports, lastCityId};
  } catch { return empty; }
}

function writeViewports(collection: ViewportCollection): void {
  if (!collection.viewports.size) {
    clearStoredViewport();
    return;
  }
  const lastCityId = collection.lastCityId && collection.viewports.has(collection.lastCityId)
    ? collection.lastCityId : collection.viewports.keys().next().value;
  mapViewportItem.set(JSON.stringify({
    version: 2, lastCityId, viewports: [...collection.viewports.values()],
  }));
}

/** Apply the global privacy floor to every city's remembered position. */
export function enforceStoredViewportPolicy(): void {
  if (!isOptionalStorageEnabledNow("viewport") || getPolicy().viewportPersistence === "off") {
    clearStoredViewport();
    return;
  }
  const required = getPolicy().viewportPersistence;
  try {
    const collection = readViewports();
    for (const [cityId, viewport] of collection.viewports) {
      if (MODE_RANK[storedMode(viewport)] < MODE_RANK[required]) collection.viewports.delete(cityId);
    }
    writeViewports(collection);
  } catch { clearStoredViewport(); }
}

/** A caller selecting a city must pass its identity; omitted keeps compatibility
 * with callers interested in the most recently saved city. */
export function loadViewport(cityId?: string): SavedViewport | null {
  enforceStoredViewportPolicy();
  if (!isOptionalStorageEnabledNow("viewport") || getPolicy().viewportPersistence === "off") return null;
  try {
    const collection = readViewports();
    const id = cityId === undefined ? collection.lastCityId : canonicalCityId(cityId);
    const v = id ? collection.viewports.get(id) : undefined;
    if (!v) return null;
    return {cityId: v.cityId, lat: v.lat, lon: v.lon, zoom: v.zoom, bearing: v.bearing, pitch: v.pitch};
  } catch { return null; }
}

function roundToGrid(
  coord: Pick<SavedViewport, "lat" | "lon">,
  meters: number,
): { lat: number; lon: number } {
  const latStep = meters / EARTH_LAT_METERS_PER_DEG;
  const lat = Math.round(coord.lat / latStep) * latStep;
  const cosLat = Math.max(0.000001, Math.cos((lat * Math.PI) / 180));
  const lonStep = meters / (EARTH_LAT_METERS_PER_DEG * cosLat);
  const lon = Math.round(coord.lon / lonStep) * lonStep;
  return { lat, lon };
}

function nearestStopLocation(
  viewport: Pick<SavedViewport, "lat" | "lon">,
  stops: readonly Pick<StopWithLines, "location">[],
): { lat: number; lon: number } | null {
  let nearest: { lat: number; lon: number } | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const stop of stops) {
    const distance = haversineDistance(viewport, stop.location);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = stop.location;
    }
  }
  return nearest;
}

/** Returns whether a permitted representation was actually persisted. */
export function saveViewport(
  v: SavedViewport,
  stops: readonly Pick<StopWithLines, "location">[] = [],
): boolean {
  enforceStoredViewportPolicy();
  if (!isOptionalStorageEnabledNow("viewport")) {
    clearStoredViewport();
    return false;
  }

  const mode = getPolicy().viewportPersistence;
  if (mode === "off") {
    clearStoredViewport();
    return false;
  }

  let storedCoord: { lat: number; lon: number } = { lat: v.lat, lon: v.lon };
  switch (mode) {
    case "raw":
      storedCoord = { lat: v.lat, lon: v.lon };
      break;
    case "snap-centroid": {
      const centroid = nearestStopLocation(v, stops);
      if (!centroid) {
        try {
          const collection = readViewports();
          collection.viewports.delete(v.cityId);
          writeViewports(collection);
        } catch { clearStoredViewport(); }
        return false;
      }
      storedCoord = centroid;
      break;
    }
    case "rounded-50m":
      storedCoord = roundToGrid(v, 50);
      break;
    case "rounded-100m":
      storedCoord = roundToGrid(v, 100);
      break;
  }

  const persisted: PersistedViewport = {
    ...v,
    ...storedCoord,
    privacyMode: mode,
    version: 1,
  };
  try {
    const valid = parseStoredViewport(JSON.stringify(persisted));
    if (!valid) return false;
    const collection = readViewports();
    collection.viewports.set(valid.cityId, valid);
    collection.lastCityId = valid.cityId;
    writeViewports(collection);
    return true;
  } catch {
    return false;
  }
}

// Privacy-level changes are synchronous in the store. This subscription makes
// a stricter viewport floor remove a now-prohibited representation immediately.
usePrivacyStore.subscribe(() => {
  enforceStoredViewportPolicy();
});
