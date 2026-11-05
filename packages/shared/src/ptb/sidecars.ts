/**
 * Reader for the two JSON sidecars the producer writes next to the PTB:
 *
 *   <bundle>.meta.json     — schemaVersion 1: producerGitSha, feedStartDate,
 *                            optional cityTzIana / derivedInseatRules, feeds[]
 *                            { url, blobSha256, etag | null }
 *   <bundle>.shapes.json   — schemaVersion 1, shapes[]
 *                            { shapeId, points[] { lat, lon, shape_dist_traveled? } }
 *
 * Both files are mandatory under Q1.E. Missing files, malformed JSON, and any
 * schemaVersion other than 1 are hard errors.
 *
 * The PTB header is the source of truth for the service-window anchor
 * (feedStartDate as a YYYYMMDD integer at header bytes [20..24]). The sidecar
 * `meta.feedStartDate` (ISO string) is retained for provenance and
 * back-compatibility; new consumers should prefer the header value decoded via
 * `feedStartDateIso()`.
 *
 * Validation is hand-rolled rather than zod because `@pt/shared`
 * intentionally keeps its runtime-dep surface minimal (only `protobufjs`).
 */

import { existsSync, readFileSync } from "node:fs";

export interface FeedMeta {
  url: string;
  blobSha256: string;
  etag: string | null;
}

export interface MetaFile {
  schemaVersion: 1;
  producerGitSha: string;
  /**
   * Day-0 of the service-bitmask window, as YYYY-MM-DD. Loaders MUST anchor
   * their service-active interpretation here — without it, every weekday
   * bit shifts by (now - feedStartDate) days and queries silently return
   * wrong-day service data.
   */
  feedStartDate: string;
  /**
   * IANA tz name (e.g. "Europe/Vilnius"). Optional: the producer omits it when
   * no city tz was supplied.
   */
  cityTzIana?: string;
  /**
   * Number of type-4 in-seat transfer rules derived from block_id
   * continuations. Present when the producer ran derivation (0 means derivation
   * ran but found none); absent when the P4 gen-dir bridge path wrote the
   * sidecar. Treated as informational — callers
   * must not hard-fail on absence.
   */
  derivedInseatRules?: number;
  feeds: FeedMeta[];
}

export interface ShapePoint {
  lat: number;
  lon: number;
  shape_dist_traveled?: number | null;
}

export interface ShapeGroup {
  shapeId: string;
  points: ShapePoint[];
  /**
   * Number of trips whose `shape_id` references this shape (from trips.txt).
   * Drives the loader's orphan-filter + cap-eviction + ordering so the PTB
   * shapes output matches the Node `buildShapesIndex` path. 0 ⇒ orphan shape,
   * dropped by the loader. Mandatory under schemaVersion 1 (producer + backend
   * upgrade in lockstep), like every other sidecar field.
   */
  tripRefCount: number;
}

export interface ShapesFile {
  schemaVersion: 1;
  shapes: ShapeGroup[];
}

export interface Sidecars {
  meta: MetaFile;
  shapes: ShapesFile;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function bad(field: string, reason: string): never {
  throw new Error(`ptb sidecar: invalid ${field} — ${reason}`);
}

function asObject(v: unknown, field: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) bad(field, `expected object, got ${typeJs(v)}`);
  return v as Record<string, unknown>;
}

function asArray(v: unknown, field: string): unknown[] {
  if (!Array.isArray(v)) bad(field, `expected array, got ${typeJs(v)}`);
  return v;
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") bad(field, `expected string, got ${typeJs(v)}`);
  return v;
}

function asNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) bad(field, `expected finite number, got ${typeJs(v)}`);
  return v;
}

function typeJs(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function parseMeta(raw: unknown): MetaFile {
  const o = asObject(raw, "meta");
  if (o.schemaVersion !== 1) {
    bad("meta.schemaVersion", `expected literal 1, got ${JSON.stringify(o.schemaVersion)}`);
  }
  const producerGitSha = asString(o.producerGitSha, "meta.producerGitSha");
  const cityTzIana = o.cityTzIana === undefined ? undefined : asString(o.cityTzIana, "meta.cityTzIana");
  const derivedInseatRules =
    o.derivedInseatRules === undefined ? undefined : asNumber(o.derivedInseatRules, "meta.derivedInseatRules");
  const feedStartDate = asString(o.feedStartDate, "meta.feedStartDate");
  if (!ISO_DATE.test(feedStartDate)) {
    bad("meta.feedStartDate", `expected YYYY-MM-DD, got ${JSON.stringify(feedStartDate)}`);
  }
  const feedsRaw = asArray(o.feeds, "meta.feeds");
  const feeds: FeedMeta[] = feedsRaw.map((f, i) => {
    const fo = asObject(f, `meta.feeds[${i}]`);
    const url = asString(fo.url, `meta.feeds[${i}].url`);
    const blobSha256 = asString(fo.blobSha256, `meta.feeds[${i}].blobSha256`);
    if (!SHA256_HEX.test(blobSha256)) {
      bad(`meta.feeds[${i}].blobSha256`, "not 64 lowercase hex chars");
    }
    let etag: string | null;
    if (fo.etag === null) {
      etag = null;
    } else if (typeof fo.etag === "string") {
      etag = fo.etag;
    } else {
      return bad(`meta.feeds[${i}].etag`, `expected string|null, got ${typeJs(fo.etag)}`);
    }
    return { url, blobSha256, etag };
  });
  return {
    schemaVersion: 1,
    producerGitSha,
    feedStartDate,
    feeds,
    ...(cityTzIana === undefined ? {} : { cityTzIana }),
    ...(derivedInseatRules === undefined ? {} : { derivedInseatRules }),
  };
}

function parseShapes(raw: unknown): ShapesFile {
  const o = asObject(raw, "shapes");
  if (o.schemaVersion !== 1) {
    bad("shapes.schemaVersion", `expected literal 1, got ${JSON.stringify(o.schemaVersion)}`);
  }
  const shapesRaw = asArray(o.shapes, "shapes.shapes");
  const shapes: ShapeGroup[] = shapesRaw.map((s, i) => {
    const so = asObject(s, `shapes.shapes[${i}]`);
    const shapeId = asString(so.shapeId, `shapes.shapes[${i}].shapeId`);
    const pointsRaw = asArray(so.points, `shapes.shapes[${i}].points`);
    const points: ShapePoint[] = pointsRaw.map((p, j) => {
      const po = asObject(p, `shapes.shapes[${i}].points[${j}]`);
      const lat = asNumber(po.lat, `shapes.shapes[${i}].points[${j}].lat`);
      const lon = asNumber(po.lon, `shapes.shapes[${i}].points[${j}].lon`);
      let shape_dist_traveled: number | null | undefined;
      if (po.shape_dist_traveled === undefined) {
        shape_dist_traveled = undefined;
      } else if (po.shape_dist_traveled === null) {
        shape_dist_traveled = null;
      } else if (typeof po.shape_dist_traveled === "number" && Number.isFinite(po.shape_dist_traveled)) {
        shape_dist_traveled = po.shape_dist_traveled;
      } else {
        bad(
          `shapes.shapes[${i}].points[${j}].shape_dist_traveled`,
          `expected number|null|absent, got ${typeJs(po.shape_dist_traveled)}`,
        );
      }
      return shape_dist_traveled === undefined ? { lat, lon } : { lat, lon, shape_dist_traveled };
    });
    const tripRefCount = asNumber(so.tripRefCount, `shapes.shapes[${i}].tripRefCount`);
    if (!Number.isInteger(tripRefCount) || tripRefCount < 0) {
      bad(`shapes.shapes[${i}].tripRefCount`, `expected non-negative integer, got ${JSON.stringify(so.tripRefCount)}`);
    }
    return { shapeId, points, tripRefCount };
  });
  return { schemaVersion: 1, shapes };
}

/**
 * Read and validate the meta + shapes sidecars for a given PTB path.
 * Both files are mandatory; missing/malformed files throw with a path
 * in the message so the boot-time error surfaces the misconfig clearly.
 */
export function readSidecars(bundlePath: string): Sidecars {
  const metaPath = `${bundlePath}.meta.json`;
  const shapesPath = `${bundlePath}.shapes.json`;
  if (!existsSync(metaPath)) throw new Error(`ptb sidecar missing: ${metaPath}`);
  if (!existsSync(shapesPath)) throw new Error(`ptb sidecar missing: ${shapesPath}`);
  const meta = parseMeta(JSON.parse(readFileSync(metaPath, "utf8")));
  const shapes = parseShapes(JSON.parse(readFileSync(shapesPath, "utf8")));
  return { meta, shapes };
}

/** Header feedStartDate is a YYYYMMDD integer; backend date math wants ISO. */
export function feedStartDateIso(yyyymmdd: number): string {
  // 0 = sentinel ("no dated services"); mirror the producer's format_ymd → 1970-01-01.
  if (yyyymmdd === 0) return "1970-01-01";
  const y = Math.floor(yyyymmdd / 10000);
  const m = Math.floor((yyyymmdd % 10000) / 100);
  const d = yyyymmdd % 100;
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}
