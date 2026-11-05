import {
  POI_MANIFEST_SCHEMA_VERSION,
  selectStrictPoiManifestBundle,
  type PoiManifest,
  type PoiTileBounds,
  type PoiTileManifest,
  type TileAnchor,
} from "@pt/shared/poi";
import {
  db,
  type PoiTileGenerationRecord,
} from "../db/index.ts";
import {
  activateTileGeneration,
  deactivateTileGeneration,
  prepareTileGeneration,
  StalePoiTileGenerationError,
  type PoiTileGeneration,
} from "./tileCache.ts";

export interface CityPoiTiling {
  edgeKm: number;
  anchor: TileAnchor;
  bundleSha256: string;
  /** Local digest of the complete tiled-delivery contract. This is deliberately
   * distinct from `bundleSha256`, which remains the server API `?v=` value. */
  generationId: string;
  /** Client-serving grid bounds — the bounded "whole city" tile-key pool
   * `tileLoader`'s prefetch/padding-decoy defense selects from. */
  tileBounds: PoiTileBounds;
}

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const TILING_POLICIES = new Set([
  "k-anon-floor",
  "byte-budget",
  "fixed-edge",
]);

// Share discovery briefly across cities; periodically revalidate so an open
// page can adopt deployment updates without a new application build.
type ManifestFetchResult =
  | { kind: "manifest"; manifest: PoiManifest }
  | { kind: "network-failure" }
  | { kind: "not-deployed" }
  | { kind: "unavailable" };

let manifestPromise: Promise<ManifestFetchResult> | null = null;
let manifestEpoch = 0;
let manifestFetchedAt = 0;
const MANIFEST_TTL_MS = 60_000;
const activeTilingByCity = new Map<string, CityPoiTiling>();
const activationTailByCity = new Map<string, Promise<void>>();
const STORED_PREPARE_ATTEMPTS = 3;

function serializeCityActivation<T>(
  cityId: string,
  task: () => Promise<T>,
): Promise<T> {
  const prior = activationTailByCity.get(cityId) ?? Promise.resolve();
  const result = prior.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  activationTailByCity.set(cityId, settled);
  void settled.then(() => {
    if (activationTailByCity.get(cityId) === settled) {
      activationTailByCity.delete(cityId);
    }
  });
  return result;
}

function fetchManifest(): Promise<ManifestFetchResult> {
  if (manifestPromise && Date.now() - manifestFetchedAt < MANIFEST_TTL_MS) return manifestPromise;
  manifestFetchedAt = Date.now();

  const requestEpoch = manifestEpoch;
  const request = (async (): Promise<ManifestFetchResult> => {
    let response: Response;
    try {
      response = await fetch("/poi/manifest.json", {
        cache: "no-cache",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      return { kind: "network-failure" };
    }
    // 404 is a definitive "this deployment publishes no managed POI". An
    // SPA fallback (the HTML shell served for an absent file) means the same.
    if (response.status === 404) return { kind: "not-deployed" };
    if (response.ok && (response.headers?.get("content-type") ?? "").includes("text/html")) {
      return { kind: "not-deployed" };
    }
    if (!response.ok) return { kind: "unavailable" };
    try {
      return {
        kind: "manifest",
        manifest: (await response.json()) as PoiManifest,
      };
    } catch {
      return { kind: "unavailable" };
    }
  })();
  manifestPromise = request;
  void request.then((result) => {
    // Keep only a successful response from the current cache epoch. Failures
    // retry, and a 409 invalidation cannot be undone by an older in-flight fetch.
    if (
      (result.kind !== "manifest" || requestEpoch !== manifestEpoch) &&
      manifestPromise === request
    ) {
      manifestPromise = null;
    }
  });
  return request;
}


export interface PoiBundleResource {
  url: string;
  sha256: string;
  sizeBytes: number;
  activationRevision: number;
}

/** Resolve only immutable same-origin managed resources. No mutable bundle URL
 * fallback: a missing or malformed deployment manifest leaves offline data intact.
 * "not-deployed" means the deployment has no POI manifest at all (404). */
export async function discoverPoiBundleResource(
  cityId: string,
  tier: "strict" | "loose",
): Promise<PoiBundleResource | "not-deployed" | null> {
  const result = await fetchManifest();
  if (result.kind === "not-deployed") return "not-deployed";
  if (result.kind !== "manifest") return null;
  const manifest = result.manifest;
  if (
    manifest.schemaVersion !== POI_MANIFEST_SCHEMA_VERSION ||
    !Number.isSafeInteger(manifest.activationRevision) ||
    (manifest.activationRevision ?? 0) < 1 ||
    !/^\/poi\/releases\/[0-9a-f]{64}\/$/.test(manifest.baseUrl ?? "") ||
    !Array.isArray(manifest.bundles)
  ) return null;
  const filename = tier === "strict" ? `${cityId}.br` : `${cityId}.loose.br`;
  const records = manifest.bundles.filter(record =>
    record.cityId === cityId && record.filename === filename);
  if (records.length !== 1) return null;
  const record = records[0]!;
  if (
    !LOWERCASE_SHA256.test(record.sha256 ?? "") ||
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes < 1 ||
    record.sizeBytes > 64 * 1024 * 1024
  ) return null;
  return {
    url: manifest.baseUrl + filename,
    sha256: record.sha256!,
    sizeBytes: record.sizeBytes,
    activationRevision: manifest.activationRevision!,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidTileContract(value: unknown): value is PoiTileManifest {
  if (!value || typeof value !== "object") return false;
  const tile = value as Partial<PoiTileManifest>;
  const anchor = tile.anchor;
  const bounds = tile.tileBounds;
  return (
    isFiniteNumber(tile.edgeKm) &&
    tile.edgeKm > 0 &&
    !!anchor &&
    isFiniteNumber(anchor.minLat) &&
    anchor.minLat >= -90 &&
    anchor.minLat <= 90 &&
    isFiniteNumber(anchor.minLon) &&
    anchor.minLon >= -180 &&
    anchor.minLon <= 180 &&
    isFiniteNumber(anchor.refLat) &&
    anchor.refLat >= -90 &&
    anchor.refLat <= 90 &&
    !!bounds &&
    Number.isInteger(bounds.minX) &&
    Number.isInteger(bounds.maxX) &&
    Number.isInteger(bounds.minY) &&
    Number.isInteger(bounds.maxY) &&
    bounds.minX <= bounds.maxX &&
    bounds.minY <= bounds.maxY &&
    typeof tile.tilingPolicy === "string" &&
    TILING_POLICIES.has(tile.tilingPolicy) &&
    typeof tile.kAnonWaived === "boolean" &&
    tile.deliveryActive === true
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canonicalContract(
  cityId: string,
  bundleSha256: string,
  tile: PoiTileManifest,
): string {
  return JSON.stringify({
    schemaVersion: POI_MANIFEST_SCHEMA_VERSION,
    cityId,
    bundleSha256,
    edgeKm: tile.edgeKm,
    anchor: [tile.anchor.minLat, tile.anchor.minLon, tile.anchor.refLat],
    tileBounds: [
      tile.tileBounds.minX,
      tile.tileBounds.maxX,
      tile.tileBounds.minY,
      tile.tileBounds.maxY,
    ],
    tilingPolicy: tile.tilingPolicy,
    kAnonWaived: tile.kAnonWaived,
    deliveryActive: tile.deliveryActive,
  });
}

async function generationRecord(
  cityId: string,
  bundleSha256: string,
  tile: PoiTileManifest,
  validatedAt: number,
  manifestGeneratedAt: number | undefined,
  activationRevision: number | undefined,
): Promise<PoiTileGenerationRecord> {
  const generationId = await sha256Hex(
    canonicalContract(cityId, bundleSha256, tile),
  );
  return {
    cityId,
    generationId,
    bundleSha256,
    schemaVersion: POI_MANIFEST_SCHEMA_VERSION,
    edgeKm: tile.edgeKm,
    anchor: { ...tile.anchor },
    tileBounds: { ...tile.tileBounds },
    tilingPolicy: tile.tilingPolicy,
    kAnonWaived: tile.kAnonWaived,
    deliveryActive: true,
    validatedAt,
    manifestGeneratedAt,
    activationRevision,
  };
}

function recordContract(record: PoiTileGenerationRecord): PoiTileManifest {
  return {
    edgeKm: record.edgeKm,
    anchor: record.anchor,
    tileBounds: record.tileBounds,
    tilingPolicy: record.tilingPolicy,
    kAnonWaived: record.kAnonWaived,
    deliveryActive: record.deliveryActive,
  };
}

async function validateStoredRecord(
  record: PoiTileGenerationRecord,
): Promise<boolean> {
  if (
    (record.activationRevision !== undefined && (!Number.isSafeInteger(record.activationRevision) || record.activationRevision < 1)) ||
    record.schemaVersion !== POI_MANIFEST_SCHEMA_VERSION ||
    !LOWERCASE_SHA256.test(record.bundleSha256) ||
    !LOWERCASE_SHA256.test(record.generationId)
  ) {
    return false;
  }
  const tile = recordContract(record);
  if (!isValidTileContract(tile)) return false;
  return (
    (await sha256Hex(canonicalContract(record.cityId, record.bundleSha256, tile))) ===
    record.generationId
  );
}

function cityTiling(record: PoiTileGenerationRecord): CityPoiTiling {
  return {
    edgeKm: record.edgeKm,
    anchor: record.anchor,
    bundleSha256: record.bundleSha256,
    generationId: record.generationId,
    tileBounds: { ...record.tileBounds },
  };
}

function tileGeneration(
  record: PoiTileGenerationRecord,
): PoiTileGeneration {
  return {
    cityId: record.cityId,
    bundleSha256: record.bundleSha256,
    generationId: record.generationId,
  };
}

function recordMatchesGeneration(
  record: PoiTileGenerationRecord | undefined,
  generation: PoiTileGeneration,
): boolean {
  return (
    record?.deliveryActive === true &&
    record.cityId === generation.cityId &&
    record.bundleSha256 === generation.bundleSha256 &&
    record.generationId === generation.generationId
  );
}

async function activateFetchedRecord(
  record: PoiTileGenerationRecord,
  requestEpoch: number,
): Promise<CityPoiTiling | null> {
  return serializeCityActivation(record.cityId, async () => {
    if (requestEpoch !== manifestEpoch) return null;
    // The winner may be `record` itself, or an already-persisted, STRICTLY
    // newer cross-tab release that `activateTileGeneration` refused to
    // overwrite (manifestGeneratedAt monotonic guard) — always tile off the
    // returned winner, never the input `record`.
    const winner = await activateTileGeneration(record);
    if (requestEpoch !== manifestEpoch) {
      await deactivateTileGeneration(record.cityId, tileGeneration(winner));
      return null;
    }
    if (winner.deliveryActive !== true) { activeTilingByCity.delete(record.cityId); return null; }
    const tiling = cityTiling(winner);
    activeTilingByCity.set(record.cityId, tiling);
    return tiling;
  });
}

async function deactivateForManifest(
  cityId: string,
  requestEpoch: number,
  activationRevision?: number,
): Promise<void> {
  await serializeCityActivation(cityId, async () => {
    if (requestEpoch !== manifestEpoch) return;
    await deactivateTileGeneration(cityId, undefined, activationRevision);
    if (requestEpoch === manifestEpoch) {
      activeTilingByCity.delete(cityId);
    }
  });
}

async function useStoredTiling(
  cityId: string,
  requestEpoch: number,
): Promise<CityPoiTiling | null> {
  for (let attempt = 0; attempt < STORED_PREPARE_ATTEMPTS; attempt += 1) {
    if (requestEpoch !== manifestEpoch) return null;
    const record = await db.poiTileGenerations.get(cityId);
    if (!record || record.deliveryActive !== true) {
      activeTilingByCity.delete(cityId);
      return null;
    }
    if (!(await validateStoredRecord(record))) {
      const cleanup = await serializeCityActivation(cityId, async () => {
        if (requestEpoch !== manifestEpoch) return "invalidated" as const;
        await deactivateTileGeneration(cityId, tileGeneration(record));
        const persisted = await db.poiTileGenerations.get(cityId);
        if (
          persisted &&
          !recordMatchesGeneration(persisted, tileGeneration(record))
        ) {
          return "retry" as const;
        }
        activeTilingByCity.delete(cityId);
        return "rejected" as const;
      });
      if (cleanup === "retry") continue;
      return null;
    }

    const generation = tileGeneration(record);
    const prepared = await serializeCityActivation(cityId, async () => {
      if (requestEpoch !== manifestEpoch) return "invalidated" as const;
      try {
        await prepareTileGeneration(generation);
      } catch (error) {
        if (error instanceof StalePoiTileGenerationError) {
          return "retry" as const;
        }
        throw error;
      }
      if (requestEpoch !== manifestEpoch) return "invalidated" as const;

      // `prepareTileGeneration` protects its transaction, while this second read
      // also catches a same-tab cached state that a newer cross-tab commit replaced.
      const persisted = await db.poiTileGenerations.get(cityId);
      if (!recordMatchesGeneration(persisted, generation)) {
        return "retry" as const;
      }
      const tiling = cityTiling(record);
      activeTilingByCity.set(cityId, tiling);
      return tiling;
    });

    if (prepared === "invalidated") return null;
    if (prepared !== "retry") return prepared;
  }

  activeTilingByCity.delete(cityId);
  return null;
}

/** Resolve a city's active tiled-delivery contract. A manifest with any other
 * schemaVersion, or a city without an active strict record, deactivates tiling
 * so the caller falls back to whole-bundle delivery. */
export async function getCityPoiTiling(cityId: string): Promise<CityPoiTiling | null> {
  const requestEpoch = manifestEpoch;
  const fetched = await fetchManifest();
  if (requestEpoch !== manifestEpoch) return null;
  if (fetched.kind === "network-failure") {
    return useStoredTiling(cityId, requestEpoch);
  }
  if (fetched.kind !== "manifest") return null;
  const { manifest } = fetched;
  if (manifest.activationRevision !== undefined && (!Number.isSafeInteger(manifest.activationRevision) || manifest.activationRevision < 1)) {
    return useStoredTiling(cityId, requestEpoch);
  }
  if (
    manifest.schemaVersion !== POI_MANIFEST_SCHEMA_VERSION
  ) {
    await deactivateForManifest(cityId, requestEpoch, manifest.activationRevision);
    return null;
  }
  let bundle;
  try {
    bundle = selectStrictPoiManifestBundle(manifest, cityId);
  } catch {
    await deactivateForManifest(cityId, requestEpoch, manifest.activationRevision);
    return null;
  }
  if (
    !bundle ||
    !bundle.sha256 ||
    !LOWERCASE_SHA256.test(bundle.sha256) ||
    !isValidTileContract(bundle.poiTile)
  ) {
    await deactivateForManifest(cityId, requestEpoch, manifest.activationRevision);
    return null;
  }
  const bundleSha256 = bundle.sha256;
  const record = await generationRecord(
    cityId,
    bundleSha256,
    bundle.poiTile,
    Date.now(),
    manifest.generatedAt,
    manifest.activationRevision,
  );
  return activateFetchedRecord(record, requestEpoch);
}

/** Synchronous hand-off used by boot wiring after `getCityPoiTiling` resolves. */
export function getActiveCityPoiTiling(
  cityId: string,
  bundleSha256: string,
): CityPoiTiling | null {
  const tiling = activeTilingByCity.get(cityId);
  return tiling?.bundleSha256 === bundleSha256 ? tiling : null;
}

/** Drop page-cached manifest state and revoke one server-rejected generation. */
export async function invalidateCityPoiTiling(
  cityId: string,
  rejectedGeneration?: {
    cityId: string;
    bundleSha256: string;
    generationId: string;
  },
): Promise<void> {
  manifestEpoch += 1;
  manifestPromise = null;
  activeTilingByCity.clear();
  await serializeCityActivation(cityId, () =>
    deactivateTileGeneration(cityId, rejectedGeneration),
  );
}

/** Test-only: reset the in-module cache. */
export function __resetPoiManifestForTests(): void {
  manifestEpoch += 1;
  manifestPromise = null;
  activeTilingByCity.clear();
}
