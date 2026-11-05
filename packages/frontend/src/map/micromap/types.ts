/**
 * Wire format of the offline city micromap (`/micromap/<city>.micromap.br`).
 *
 * Produced by `scripts/build-micromap.mjs` from OpenStreetMap; format and
 * budget rationale in the micromap notes. Keys are short because the artifact
 * ships as brotli-compressed JSON and is measured in tens of kilobytes:
 *
 *   r  rings — first entry is the outer ring, the rest are holes
 *   g  geometry — one encoded polyline
 *   c  class
 *   n  name, y latitude, x longitude, r rank (places)
 *
 * Geometry is Google Encoded Polyline, precision 5 — the same codec the app
 * already decodes for GTFS shapes (`utils/polyline.ts`).
 */

export const MICROMAP_VERSION = 1;

export const MICROMAP_ROAD_CLASSES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
] as const;
export type MicromapRoadClass = (typeof MICROMAP_ROAD_CLASSES)[number];

export const MICROMAP_WATERWAY_CLASSES = ["river", "canal", "stream"] as const;
export type MicromapWaterwayClass = (typeof MICROMAP_WATERWAY_CLASSES)[number];

export interface MicromapArea {
  /** Encoded rings; `r[0]` is the outer ring, `r[1..]` are holes. */
  r: string[];
}

export interface MicromapLine {
  c: string;
  g: string;
}

export interface MicromapPlace {
  n: string;
  y: number;
  x: number;
  /** 1 = city, 2 = town, 3 = suburb/quarter, 4 = village/neighbourhood. */
  r: number;
}

export interface MicromapArtifact {
  version: number;
  cityId: string;
  generatedAt: string;
  attribution: string;
  /** `[minLon, minLat, maxLon, maxLat]`. */
  bbox: [number, number, number, number];
  water: MicromapArea[];
  green: MicromapArea[];
  waterways: MicromapLine[];
  roads: MicromapLine[];
  places: MicromapPlace[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function areas(value: unknown): MicromapArea[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is MicromapArea =>
      typeof entry === "object" &&
      entry !== null &&
      isStringArray((entry as MicromapArea).r) &&
      (entry as MicromapArea).r.length > 0,
  );
}

function lines(value: unknown): MicromapLine[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is MicromapLine =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as MicromapLine).c === "string" &&
      typeof (entry as MicromapLine).g === "string",
  );
}

function places(value: unknown): MicromapPlace[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is MicromapPlace =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as MicromapPlace).n === "string" &&
      Number.isFinite((entry as MicromapPlace).y) &&
      Number.isFinite((entry as MicromapPlace).x),
  );
}

function bbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  return value as [number, number, number, number];
}

/**
 * Validate a decoded artifact. Unknown versions are rejected rather than
 * best-effort rendered: a stale artifact left in a browser cache after a
 * format change must fall back to corridors, not paint a wrong city.
 * Individual malformed entries are dropped, since one bad ring should not
 * cost the user the whole map.
 */
export function parseMicromapArtifact(value: unknown): MicromapArtifact | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<MicromapArtifact>;
  if (raw.version !== MICROMAP_VERSION) return null;
  if (typeof raw.cityId !== "string" || raw.cityId.length === 0) return null;
  const box = bbox(raw.bbox);
  if (!box) return null;

  return {
    version: MICROMAP_VERSION,
    cityId: raw.cityId,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
    attribution:
      typeof raw.attribution === "string"
        ? raw.attribution
        : "© OpenStreetMap contributors",
    bbox: box,
    water: areas(raw.water),
    green: areas(raw.green),
    waterways: lines(raw.waterways),
    roads: lines(raw.roads),
    places: places(raw.places),
  };
}

export function isMicromapEmpty(artifact: MicromapArtifact): boolean {
  return (
    artifact.water.length === 0 &&
    artifact.green.length === 0 &&
    artifact.waterways.length === 0 &&
    artifact.roads.length === 0 &&
    artifact.places.length === 0
  );
}
