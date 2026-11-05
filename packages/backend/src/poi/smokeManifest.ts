#!/usr/bin/env tsx
/** Validate a built POI artifact directory. Usage: tsx smokeManifest.ts <outDir> */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import {
  POI_MANIFEST_SCHEMA_VERSION,
  TILE_MIN_K,
  tileKeyAt,
  type PoiBundle,
  type PoiManifest,
} from "@pt/shared";

const MAX_POI_CITY_SLOTS = 5;
const MAX_BUNDLE_BYTES = 1024 * 1024;
const MAX_RESPONSE_CACHE_ENTRIES = 256;
const CITY_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: smokeManifest.ts <outDir>");
  process.exit(2);
}

const manifestPath = join(dir, "manifest.json");
if (!existsSync(manifestPath)) fail("manifest.json is missing");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PoiManifest;
if (
  manifest.schemaVersion !== POI_MANIFEST_SCHEMA_VERSION ||
  !Array.isArray(manifest.bundles)
) {
  fail(`invalid schemaVersion/bundles in manifest.json`);
}

const strictCities = new Set<string>();
let activeStrictCount = 0;
let activeCoordinateEnvelope = 0;
for (const bundle of manifest.bundles) {
  if (
    typeof bundle.cityId !== "string" ||
    typeof bundle.filename !== "string" ||
    basename(bundle.filename) !== bundle.filename ||
    !Number.isSafeInteger(bundle.sizeBytes) ||
    bundle.sizeBytes <= 0 ||
    !/^[0-9a-f]{64}$/.test(bundle.sha256 ?? "")
  ) {
    fail(`invalid manifest record for ${String(bundle.cityId)}`);
  }

  const strictRecord = bundle.filename === `${bundle.cityId}.br`;
  if (strictRecord) {
    if (
      !CITY_ID_PATTERN.test(bundle.cityId) ||
      bundle.sizeBytes > MAX_BUNDLE_BYTES
    ) {
      fail(`invalid strict manifest record for ${bundle.cityId}`);
    }
    if (strictCities.has(bundle.cityId)) {
      fail(`duplicate strict manifest record for ${bundle.cityId}`);
    }
    strictCities.add(bundle.cityId);
    if (strictCities.size > MAX_POI_CITY_SLOTS) {
      fail(`manifest has more than ${MAX_POI_CITY_SLOTS} strict POI cities`);
    }
  }

  const artifactPath = join(dir, bundle.filename);
  if (!existsSync(artifactPath)) fail(`${bundle.filename} is missing`);
  const bytes = readFileSync(artifactPath);
  if (bytes.length !== bundle.sizeBytes) {
    fail(`${bundle.filename} size ${bytes.length} != ${bundle.sizeBytes}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== bundle.sha256) fail(`${bundle.filename} sha256 mismatch`);

  if (!bundle.poiTile) continue;
  const {
    edgeKm,
    anchor,
    deliveryActive,
    tilingPolicy,
    kAnonWaived,
    tileBounds,
  } = bundle.poiTile;
  if (
    !Number.isFinite(edgeKm) ||
    edgeKm < 3 ||
    edgeKm > 200 ||
    !Number.isFinite(anchor?.minLat) ||
    !Number.isFinite(anchor?.minLon) ||
    !Number.isFinite(anchor?.refLat) ||
    typeof deliveryActive !== "boolean" ||
    (tilingPolicy !== "k-anon-floor" &&
      tilingPolicy !== "byte-budget" &&
      tilingPolicy !== "fixed-edge") ||
    typeof kAnonWaived !== "boolean" ||
    ![tileBounds?.minX, tileBounds?.maxX, tileBounds?.minY, tileBounds?.maxY].every(
      (coord) => Number.isSafeInteger(coord) && Math.abs(coord) <= 999_999,
    ) ||
    tileBounds.minX > tileBounds.maxX ||
    tileBounds.minY > tileBounds.maxY
  ) {
    fail(`${bundle.cityId} has invalid poiTile metadata`);
  }
  if (
    (tilingPolicy === "k-anon-floor" && kAnonWaived) ||
    (tilingPolicy !== "k-anon-floor" && !kAnonWaived)
  ) {
    fail(`${bundle.cityId} has inconsistent k-anonymity waiver metadata`);
  }
  if (strictRecord && deliveryActive) {
    activeStrictCount += 1;

    let decoded: Buffer;
    try {
      decoded = brotliDecompressSync(bytes, {
        maxOutputLength: MAX_BUNDLE_BYTES,
      });
    } catch {
      fail(`${bundle.filename} cannot be decompressed within the serving cap`);
    }
    let corpus: PoiBundle;
    try {
      corpus = JSON.parse(decoded.toString("utf8")) as PoiBundle;
    } catch {
      fail(`${bundle.filename} is not valid POI bundle JSON`);
    }
    if (
      corpus.meta?.cityId !== bundle.cityId ||
      corpus.meta?.tier !== "strict" ||
      !Array.isArray(corpus.entries) ||
      corpus.meta.entryCount !== corpus.entries.length ||
      corpus.entries.length === 0 ||
      corpus.entries.some((entry) => entry.tier !== "strict")
    ) {
      fail(`${bundle.filename} has invalid bundle metadata or an empty active corpus`);
    }

    const occupiedCounts = new Map<string, number>();
    for (const entry of corpus.entries) {
      if (
        !Number.isFinite(entry.lat) ||
        entry.lat < -90 ||
        entry.lat > 90 ||
        !Number.isFinite(entry.lon) ||
        entry.lon < -180 ||
        entry.lon > 180
      ) {
        fail(`${bundle.filename} contains an out-of-range coordinate`);
      }
      const coords = tileKeyAt(
        bundle.cityId,
        entry.lat,
        entry.lon,
        edgeKm,
        anchor,
      ).split("/").at(-1);
      const match = coords ? /^(-?\d{1,6})_(-?\d{1,6})$/.exec(coords) : null;
      if (!match) {
        fail(`${bundle.filename} exceeds the six-digit tile-coordinate contract`);
      }
      const x = Number(match[1]);
      const y = Number(match[2]);
      if (`${x}_${y}` !== coords) {
        fail(`${bundle.filename} emitted a non-canonical tile coordinate`);
      }
      if (
        x < tileBounds.minX ||
        x > tileBounds.maxX ||
        y < tileBounds.minY ||
        y > tileBounds.maxY
      ) {
        fail(`${bundle.filename} contains an entry outside tileBounds`);
      }
      occupiedCounts.set(coords, (occupiedCounts.get(coords) ?? 0) + 1);
    }
    if (
      tilingPolicy === "k-anon-floor" &&
      [...occupiedCounts.values()].some((count) => count < TILE_MIN_K)
    ) {
      fail(`${bundle.filename} contains an occupied tile below k=${TILE_MIN_K}`);
    }

    activeCoordinateEnvelope +=
      (tileBounds.maxX - tileBounds.minX + 1) *
      (tileBounds.maxY - tileBounds.minY + 1);
    if (activeCoordinateEnvelope > MAX_RESPONSE_CACHE_ENTRIES) {
      fail(
        `active POI corpora expose ${activeCoordinateEnvelope} coordinates; cache holds ${MAX_RESPONSE_CACHE_ENTRIES}`,
      );
    }
  }
}

if (activeStrictCount === 0) {
  fail("manifest contains no active strict POI tile corpus");
}

const skips = existsSync(join(dir, "poi-sub-k-skips.json"))
  ? JSON.parse(readFileSync(join(dir, "poi-sub-k-skips.json"), "utf8"))
  : [];
console.log(
  `schemaVersion=${POI_MANIFEST_SCHEMA_VERSION}; strict=${strictCities.size}; activeStrict=${activeStrictCount}; coordinates=${activeCoordinateEnvelope}; skips=${skips.length}`,
);
