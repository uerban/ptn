import type { LatLon, PrivacyPolicy } from "@pt/shared";

declare const _stored: unique symbol;
declare const _coarsened: unique symbol;

export type StoredMapPoint = {
  readonly lat: number;
  readonly lon: number;
  readonly [_stored]: true;
};

export interface CoarsenedRequest {
  readonly snappedCoord: { lat: number; lon: number };
  readonly gridMeters: number;
  readonly originalWithheld: true;
  readonly [_coarsened]: true;
}

const EARTH_LAT_METERS_PER_DEG = 111_320;

function snapToGrid(raw: LatLon, meters: number): LatLon {
  const latStep = meters / EARTH_LAT_METERS_PER_DEG;
  const lat = Math.round(raw.lat / latStep) * latStep;
  // Derive lonStep from the snapped lat so two raw points in the same lat cell
  // resolve to an identical lon grid — makes the mapping idempotent.
  const lonStep =
    meters / (EARTH_LAT_METERS_PER_DEG * Math.cos((lat * Math.PI) / 180));
  const lon = Math.round(raw.lon / lonStep) * lonStep;
  return { lat, lon };
}

const JITTER_STATE_KEY = "ptn_jitter_state";

let sessionFractions: { fLat: number; fLon: number } | null = null;
let currentNonce: string | null = null;

interface JitterState {
  nonce: string;
  fLat: number;
  fLon: number;
}

function readState(): JitterState | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(JITTER_STATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (typeof s?.nonce !== "string" || typeof s?.fLat !== "number" || typeof s?.fLon !== "number") return null;
    return s as JitterState;
  } catch {
    return null;
  }
}

function writeState(state: JitterState): void {
  try {
    globalThis.sessionStorage?.setItem(JITTER_STATE_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage unavailable (SSR, privacy mode) — jitter still works in-memory
  }
}

export function getSessionJitter(): { fLat: number; fLon: number } {
  if (sessionFractions && currentNonce) {
    return sessionFractions;
  }

  const stored = readState();
  if (stored) {
    currentNonce = stored.nonce;
    sessionFractions = { fLat: stored.fLat, fLon: stored.fLon };
    return sessionFractions;
  }

  currentNonce = crypto.randomUUID();
  sessionFractions = {
    fLat: Math.random() - 0.5,
    fLon: Math.random() - 0.5,
  };
  writeState({ nonce: currentNonce, ...sessionFractions });
  return sessionFractions;
}

export function _resetSessionJitter(): void {
  sessionFractions = null;
  currentNonce = null;
  try {
    globalThis.sessionStorage?.removeItem(JITTER_STATE_KEY);
  } catch {
    // ignore
  }
}

export function _clearModuleState(): void {
  sessionFractions = null;
  currentNonce = null;
}

export function coarsen(raw: LatLon, gridMeters: number): CoarsenedRequest {
  const fractions = getSessionJitter();
  const latStep = gridMeters / EARTH_LAT_METERS_PER_DEG;
  const jitteredLat = raw.lat + fractions.fLat * latStep;
  const snappedLat = Math.round(jitteredLat / latStep) * latStep;
  const lonStep =
    gridMeters /
    (EARTH_LAT_METERS_PER_DEG * Math.cos((snappedLat * Math.PI) / 180));
  const jitteredLon = raw.lon + fractions.fLon * lonStep;
  const snappedLon = Math.round(jitteredLon / lonStep) * lonStep;
  return {
    snappedCoord: { lat: snappedLat, lon: snappedLon },
    gridMeters,
    originalWithheld: true,
  } as CoarsenedRequest;
}

function brand(coord: LatLon): StoredMapPoint {
  return { lat: coord.lat, lon: coord.lon } as StoredMapPoint;
}

export function persistMapTap(
  raw: LatLon,
  precision: PrivacyPolicy["mapTapPersistedPrecision"],
): StoredMapPoint {
  switch (precision) {
    case "raw":
    case "snap-centroid":
      return brand(raw);
    case "snap-rounded-50m":
      return brand(snapToGrid(raw, 50));
    case "snap-rounded-100m":
    case "snap-rounded-100m-no-reverse":
      return brand(snapToGrid(raw, 100));
  }
}
