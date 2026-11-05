import type { PrivacyPolicy, StopWithLines } from "@pt/shared";
import { isOptionalStorageEnabledNow } from "../services/privacyChoices.ts";
import { getPolicy, usePrivacyStore } from "../stores/privacyStore.ts";
import { MAP_VIEWPORT_STORAGE_KEY } from "../services/privacyStorageKeys.ts";
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

function clearStoredViewport(): void {
  try {
    globalThis.localStorage?.removeItem(MAP_VIEWPORT_STORAGE_KEY);
  } catch {
    // Storage access can fail in private mode; the caller still fails closed.
  }
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
      cityId: v.cityId,
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

/**
 * Removes a representation that is less protective than the current floor.
 * Called both at restore and synchronously when the privacy store changes.
 */
export function enforceStoredViewportPolicy(): void {
  if (!isOptionalStorageEnabledNow("viewport")) {
    clearStoredViewport();
    return;
  }
  const required = getPolicy().viewportPersistence;
  if (required === "off") {
    clearStoredViewport();
    return;
  }
  try {
    const raw = globalThis.localStorage?.getItem(MAP_VIEWPORT_STORAGE_KEY);
    if (!raw) return;
    const parsed = parseStoredViewport(raw);
    if (!parsed || MODE_RANK[storedMode(parsed)] < MODE_RANK[required]) {
      clearStoredViewport();
    }
  } catch {
    clearStoredViewport();
  }
}

export function loadViewport(): SavedViewport | null {
  if (!isOptionalStorageEnabledNow("viewport")) {
    clearStoredViewport();
    return null;
  }
  const required = getPolicy().viewportPersistence;
  if (required === "off") {
    clearStoredViewport();
    return null;
  }
  try {
    const raw = globalThis.localStorage?.getItem(MAP_VIEWPORT_STORAGE_KEY);
    if (!raw) return null;
    const v = parseStoredViewport(raw);
    if (!v || MODE_RANK[storedMode(v)] < MODE_RANK[required]) {
      clearStoredViewport();
      return null;
    }
    return {
      cityId: v.cityId,
      lat: v.lat,
      lon: v.lon,
      zoom: v.zoom,
      bearing: v.bearing,
      pitch: v.pitch,
    };
  } catch {
    return null;
  }
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
        clearStoredViewport();
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
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(
      MAP_VIEWPORT_STORAGE_KEY,
      JSON.stringify(persisted),
    );
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
