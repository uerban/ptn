import type { FastifyRequest, FastifyReply } from "fastify";
import { brotliCompress, brotliDecompress, constants } from "node:zlib";
import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  POI_MANIFEST_SCHEMA_VERSION,
  TILE_MIN_K,
  tileKeyAt,
  type PoiBundle,
  type PoiEntry,
  type PoiManifest,
  type PoiManifestBundle,
  type TileAnchor,
} from "@pt/shared";

export type CityTilingResolution =
  | {
      status: "active";
      edgeKm: number;
      anchor: TileAnchor;
      bounds: PoiTileBounds;
      bundleSha256: string;
    }
  | { status: "inactive" }
  | { status: "unknown" };

export interface PoiTileBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface PoiTileDeps {
  loadCityEntries: (cityId: string) => Promise<PoiEntry[] | null>;
  /** Resolve the city's shipped tiling + activation. Returns a discriminated
   *  result so the route can distinguish 404 (unknown) from 503 (inactive). */
  resolveCityTiling: (cityId: string) => Promise<CityTilingResolution>;
  /** Validate every active corpus without retaining decoded route data.
   * Missing manifests are a retryable no-op; malformed advertised artifacts
   * reject before the listener binds. */
  preflight?: () => Promise<boolean>;
  /**
 * Per-response observability hook — called once per request with the final HTTP status.
 * Optional; default no-op. Production wiring lives in src/index.ts and routes to the
 * prom-client counter `pt_poi_tile_requests_total{status,poi_city}` (metrics/registry.ts),
 * mirroring `RaptorBundleOptions.onRequest` (observability). The in-process Map below is
 * retained for unit-test introspection (poiTileRequestCounts).
 */
  onRequest?: (status: number, poiCity: string) => void;
}

/** Bounded per-status request counter (mirrors pt_raptor_bundle_requests_total).
 *  status is one of {200, 304, 400, 404, 409, 500, 503}. Test-introspectable via
 *  poiTileRequestCounts(); production scraping goes through the onRequest hook →
 *  prom-client counter, NOT this Map (the Map is process-global and not exposed
 *  on /metrics). */
const requestCounts = new Map<string, number>();
export function poiTileRequestCounts(): ReadonlyMap<string, number> {
  return requestCounts;
}

interface PoiTileParams {
  cityId: string;
  tileSize: string;
  tileCoords: string;
}

interface PoiTileQuery {
  // Fastify parses duplicate scalar keys as an array. That cannot equal the
  // published SHA, so duplicates follow the stale-generation 409 branch.
  v?: string | string[];
}

const TILE_COORD_PATTERN = /^-?\d{1,6}_-?\d{1,6}$/;
const CITY_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const CACHE_CONTROL = "public, max-age=0, must-revalidate";
const ATTRIBUTION = "(c) OpenStreetMap contributors";
const LICENSE_URL = "https://opendatacommons.org/licenses/odbl/";

// Serves the compressed payload without re-running brotli-q11 on every request,
// which blocks the event loop and is trivially reachable from the network.
const RESPONSE_CACHE_MAX_ENTRIES = 256;
const DEFAULT_BUNDLE_MAX_BYTES = 1024 * 1024;
const MAX_POI_CITY_SLOTS = 5;
const MIN_POI_TILE_EDGE_KM = 3;
const MAX_POI_TILE_EDGE_KM = 200;
const MAX_TILE_COORD_ABS = 999_999;
const ZLIB_CONCURRENCY = 2;

function compressBrotliQ11(input: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    brotliCompress(
      input,
      { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } },
      (error, output) => (error ? reject(error) : resolvePromise(output)),
    );
  });
}

function decompressBrotli(input: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    brotliDecompress(
      input,
      { maxOutputLength },
      (error, output) => (error ? reject(error) : resolvePromise(output)),
    );
  });
}

class AsyncPermitPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolvePromise) => this.waiters.push(resolvePromise));
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) {
      throw new Error(`${path} exceeds ${maxBytes} byte cap`);
    }
    const output = Buffer.allocUnsafe(Math.min(maxBytes + 1, stat.size + 1));
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await handle.read(
        output,
        offset,
        output.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new Error(`${path} exceeds ${maxBytes} byte cap`);
    }
    return output.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function parseCanonicalTileCoords(tileCoords: string): [number, number] | null {
  if (!TILE_COORD_PATTERN.test(tileCoords)) return null;
  const [rawX, rawY] = tileCoords.split("_");
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
  return `${x}_${y}` === tileCoords ? [x, y] : null;
}

export interface PoiEntryIndex {
  bounds: PoiTileBounds;
  byCoords: Map<string, PoiEntry[]>;
}

function buildEntryIndex(
  cityId: string,
  entries: PoiEntry[],
  edgeKm: number,
  anchor: TileAnchor,
): PoiEntryIndex | null {
  let bounds: PoiTileBounds | null = null;
  const byCoords = new Map<string, PoiEntry[]>();
  for (const entry of entries) {
    if (
      !Number.isFinite(entry.lat) ||
      entry.lat < -90 ||
      entry.lat > 90 ||
      !Number.isFinite(entry.lon) ||
      entry.lon < -180 ||
      entry.lon > 180
    ) {
      throw new Error(`out-of-range POI coordinate for ${cityId}`);
    }
    const coords = tileKeyAt(cityId, entry.lat, entry.lon, edgeKm, anchor)
      .split("/")
      .at(-1);
    if (!coords) throw new Error(`tileKeyAt returned no coords for ${cityId}`);
    const parsed = parseCanonicalTileCoords(coords);
    if (!parsed) throw new Error(`tileKeyAt returned malformed coords for ${cityId}: ${coords}`);
    const [x, y] = parsed;
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, x),
          maxX: Math.max(bounds.maxX, x),
          minY: Math.min(bounds.minY, y),
          maxY: Math.max(bounds.maxY, y),
      }
      : { minX: x, maxX: x, minY: y, maxY: y };
    const bucket = byCoords.get(coords);
    if (bucket) bucket.push(entry);
    else byCoords.set(coords, [entry]);
  }
  return bounds ? { bounds, byCoords } : null;
}

interface CachedTileResponse {
  etag: string;
  compressed: Buffer;
}

export function createPoiTileHandler(deps: PoiTileDeps) {
  const responseCache = new Map<string, CachedTileResponse>();
  const responseLoads = new Map<string, Promise<CachedTileResponse>>();
  const compressionPool = new AsyncPermitPool(ZLIB_CONCURRENCY);

  function countRequest(status: number, poiCity = "unknown"): void {
    const k = String(status);
    requestCounts.set(k, (requestCounts.get(k) ?? 0) + 1);
    deps.onRequest?.(status, poiCity);
  }

  function internalError(
    request: FastifyRequest<{ Params: PoiTileParams }>,
    reply: FastifyReply,
    error: unknown,
    poiCity = "unknown",
  ): void {
    request.log.error(
      { code: "POI_BUNDLE_LOAD_ERROR", cityId: request.params.cityId, err: error },
      "poi-tile POI_BUNDLE_LOAD_ERROR: POI data could not be loaded",
    );
    countRequest(500, poiCity);
    reply.status(500).send({
      error: {
        code: "POI_BUNDLE_LOAD_ERROR",
        message: "POI data could not be loaded",
      },
    });
  }

  async function buildResponse(
    cityId: string,
    tileSize: string,
    tileCoords: string,
    tiling: Extract<CityTilingResolution, { status: "active" }>,
  ): Promise<CachedTileResponse> {
    const tileKey = `${cityId}/${tileSize}/${tileCoords}`;
    const cacheKey = `${tiling.bundleSha256}:${tileKey}`;
    const cached = responseCache.get(cacheKey);
    if (cached) {
      responseCache.delete(cacheKey);
      responseCache.set(cacheKey, cached);
      return cached;
    }
    const inflight = responseLoads.get(cacheKey);
    if (inflight) return inflight;
    const load = (async () => {
      const entries = await deps.loadCityEntries(cityId);
      if (entries === null) {
        throw new Error(`entries missing after active resolution for ${cityId}`);
      }
      const tileEntries = entries.filter(
        (entry) =>
          tileKeyAt(cityId, entry.lat, entry.lon, tiling.edgeKm, tiling.anchor) ===
          tileKey,
      );
      const json = JSON.stringify({
        tileKey,
        entries: tileEntries,
      });
      const etag = `"${createHash("sha256").update(json).digest("hex").slice(0, 16)}"`;
      const compressed = await compressionPool.run(() =>
        compressBrotliQ11(Buffer.from(json)),
      );
      const built = { etag, compressed };

      if (responseCache.size >= RESPONSE_CACHE_MAX_ENTRIES) {
        const oldestKey = responseCache.keys().next().value;
        if (oldestKey !== undefined) responseCache.delete(oldestKey);
      }
      responseCache.set(cacheKey, built);
      return built;
    })();
    responseLoads.set(cacheKey, load);
    try {
      return await load;
    } finally {
      responseLoads.delete(cacheKey);
    }
  }

  const poiTileHandler = async function poiTileHandler(
    request: FastifyRequest<{ Params: PoiTileParams; Querystring: PoiTileQuery }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { cityId, tileSize, tileCoords } = request.params;

    if (!CITY_ID_PATTERN.test(cityId)) {
      countRequest(400);
      reply.status(400).send({
        error: { code: "INVALID_CITY_ID", message: "Invalid cityId" },
      });
      return;
    }

    let tiling: CityTilingResolution;
    try {
      tiling = await deps.resolveCityTiling(cityId);
    } catch (error) {
      internalError(request, reply, error);
      return;
    }
    if (tiling.status === "unknown") {
      request.log.warn(
        { code: "UNKNOWN_CITY", cityId },
        "poi-tile UNKNOWN_CITY: city not tiled/configured",
      );
      countRequest(404);
      reply.status(404).send({
        error: { code: "UNKNOWN_CITY", message: `No POI data for city: ${cityId}` },
      });
      return;
    }
    if (tiling.status === "inactive") {
      request.log.warn(
        { code: "POI_TILE_DELIVERY_INACTIVE", cityId },
        "poi-tile POI_TILE_DELIVERY_INACTIVE: per-tile delivery off for city",
      );
      countRequest(503, cityId);
      reply.status(503).send({
        error: {
          code: "POI_TILE_DELIVERY_INACTIVE",
          message: `Per-tile POI delivery is not active for city: ${cityId}`,
        },
      });
      return;
    }

    if (request.query.v !== undefined && request.query.v !== tiling.bundleSha256) {
      countRequest(409, cityId);
      reply.status(409).send({
        error: {
          code: "POI_CORPUS_VERSION_MISMATCH",
          message: `POI corpus version changed for city: ${cityId}`,
        },
      });
      return;
    }

    const expectedLabel = `${tiling.edgeKm}km`;
    if (tileSize !== expectedLabel) {
      countRequest(400, cityId);
      reply.status(400).send({
        error: {
          code: "TILE_SIZE_MISMATCH",
          message: `Server uses ${expectedLabel} tiles for ${cityId}; got ${tileSize}`,
        },
      });
      return;
    }

    const parsedCoords = parseCanonicalTileCoords(tileCoords);
    if (!parsedCoords) {
      countRequest(400, cityId);
      reply.status(400).send({
        error: { code: "INVALID_TILE_KEY", message: `Malformed tile coords: ${tileCoords}` },
      });
      return;
    }
    const [tileX, tileY] = parsedCoords;
    if (
      tileX < tiling.bounds.minX ||
      tileX > tiling.bounds.maxX ||
      tileY < tiling.bounds.minY ||
      tileY > tiling.bounds.maxY
    ) {
      countRequest(404, cityId);
      reply.status(404).send({
        error: {
          code: "UNKNOWN_TILE",
          message: `Tile coords outside city grid: ${tileCoords}`,
        },
      });
      return;
    }

    let cached: CachedTileResponse;
    try {
      cached = await buildResponse(cityId, tileSize, tileCoords, tiling);
    } catch (error) {
      internalError(request, reply, error, cityId);
      return;
    }

    reply
      .header("Cache-Control", CACHE_CONTROL)
      .header("ETag", cached.etag)
      .header("X-POI-Attribution", ATTRIBUTION)
      .header("X-POI-License", LICENSE_URL);

    if (request.headers["if-none-match"] === cached.etag) {
      countRequest(304, cityId);
      reply.status(304).send();
      return;
    }

    countRequest(200, cityId);
    reply
      .header("Content-Type", "application/json")
      .header("Content-Encoding", "br")
      .send(cached.compressed);
  };

  poiTileHandler.prewarm = async (): Promise<boolean> =>
    (await deps.preflight?.()) ?? true;

  return poiTileHandler;
}

export type PoiTileHandler = ReturnType<typeof createPoiTileHandler>;

export interface BundleFileLoaderConfig {
  bundleDir: string;
  maxDecodedBytes?: number;
  responseCacheMaxEntries?: number;
}

export function createBundleFileLoader(config: BundleFileLoaderConfig): PoiTileDeps {
  const {
    bundleDir,
    maxDecodedBytes = DEFAULT_BUNDLE_MAX_BYTES,
    responseCacheMaxEntries = RESPONSE_CACHE_MAX_ENTRIES,
  } = config;
  const entriesCache = new Map<string, PoiEntry[]>();
  const entryLoads = new Map<string, Promise<PoiEntry[]>>();
  const tilingCache = new Map<string, CityTilingResolution>();
  const activeRecords = new Map<string, PoiManifestBundle>();
  let manifestCache: PoiManifest | null = null;
  let manifestLoad: Promise<PoiManifest | null> | null = null;
  let pinnedBundleDir: string | null = null;
  let preflightPromise: Promise<boolean> | null = null;
  let preflightComplete = false;
  let preflightFailure: unknown;

  async function loadManifest(): Promise<PoiManifest | null> {
    if (manifestCache) return manifestCache;
    if (manifestLoad) return manifestLoad;
    manifestLoad = (async () => {
      let canonicalDir: string;
      try {
        canonicalDir = await realpath(bundleDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      let bytes: Buffer;
      try {
        bytes = await readBounded(
          join(canonicalDir, "manifest.json"),
          maxDecodedBytes,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      const parsed = JSON.parse(bytes.toString("utf8")) as PoiManifest;
      if (
        parsed.schemaVersion !== POI_MANIFEST_SCHEMA_VERSION ||
        !Array.isArray(parsed.bundles)
      ) {
        throw new Error(`unsupported POI manifest schemaVersion ${parsed.schemaVersion}`);
      }
      pinnedBundleDir = canonicalDir;
      manifestCache = parsed;
      return parsed;
    })();
    try {
      return await manifestLoad;
    } finally {
      manifestLoad = null;
    }
  }

  function validateStrictRecord(
    cityId: string,
    record: PoiManifestBundle,
  ): void {
    if (
      !CITY_ID_PATTERN.test(cityId) ||
      record.filename !== `${cityId}.br` ||
      !Number.isSafeInteger(record.sizeBytes) ||
      record.sizeBytes <= 0 ||
      record.sizeBytes > maxDecodedBytes ||
      !/^[0-9a-f]{64}$/.test(record.sha256 ?? "")
    ) {
      throw new Error(`invalid strict manifest record for ${cityId}`);
    }
  }

  function validateTileBounds(
    cityId: string,
    value: PoiTileBounds,
  ): PoiTileBounds {
    const coords = [value?.minX, value?.maxX, value?.minY, value?.maxY];
    if (
      coords.some(
        (coord) =>
          !Number.isSafeInteger(coord) ||
          Math.abs(coord) > MAX_TILE_COORD_ABS,
      ) ||
      value.minX > value.maxX ||
      value.minY > value.maxY
    ) {
      throw new Error(`manifest tileBounds for ${cityId} are invalid`);
    }
    return value;
  }

  async function readCityBundle(
    cityId: string,
    record: PoiManifestBundle,
  ): Promise<PoiEntry[]> {
    validateStrictRecord(cityId, record);
    if (!pinnedBundleDir) {
      throw new Error("POI bundle directory was not pinned");
    }
    const path = join(pinnedBundleDir, record.filename);
    const compressed = await readBounded(path, maxDecodedBytes);
    if (compressed.length !== record.sizeBytes) {
      throw new Error(
        `${record.filename} has ${compressed.length} bytes; manifest advertises ${record.sizeBytes}`,
      );
    }
    const actualSha = createHash("sha256").update(compressed).digest("hex");
    if (actualSha !== record.sha256) {
      throw new Error(`${record.filename} sha256 mismatch`);
    }
    const decoded = await decompressBrotli(compressed, maxDecodedBytes);
    if (decoded.length > maxDecodedBytes) {
      throw new Error(`${record.filename} decompressed artifact exceeds byte cap`);
    }
    const bundle = JSON.parse(decoded.toString("utf8")) as PoiBundle;
    if (
      !bundle?.meta ||
      !Array.isArray(bundle.entries) ||
      bundle.meta.cityId !== cityId ||
      bundle.meta.tier !== "strict" ||
      bundle.meta.entryCount !== bundle.entries.length ||
      bundle.entries.length === 0 ||
      bundle.entries.some(
        (entry) =>
          entry.tier !== "strict" ||
          !Number.isFinite(entry.lat) ||
          entry.lat < -90 ||
          entry.lat > 90 ||
          !Number.isFinite(entry.lon) ||
          entry.lon < -180 ||
          entry.lon > 180,
      )
    ) {
      throw new Error(`${record.filename} strict bundle metadata mismatch`);
    }
    return bundle.entries;
  }

  function validateActiveTiling(
    cityId: string,
    record: PoiManifestBundle,
    entries: PoiEntry[],
  ): {
    resolution: Extract<CityTilingResolution, { status: "active" }>;
    cellCount: number;
  } {
    const tiling = record.poiTile;
    if (!tiling) throw new Error(`active strict record for ${cityId} has no poiTile`);
    if (
      !Number.isFinite(tiling.edgeKm) ||
      tiling.edgeKm < MIN_POI_TILE_EDGE_KM ||
      tiling.edgeKm > MAX_POI_TILE_EDGE_KM
    ) {
      throw new Error(
        `manifest edgeKm for ${cityId} must be between ${MIN_POI_TILE_EDGE_KM} and ${MAX_POI_TILE_EDGE_KM}`,
      );
    }
    if (
      !Number.isFinite(tiling.anchor?.minLat) ||
      tiling.anchor.minLat < -90 ||
      tiling.anchor.minLat > 90 ||
      !Number.isFinite(tiling.anchor?.minLon) ||
      tiling.anchor.minLon < -180 ||
      tiling.anchor.minLon > 180 ||
      !Number.isFinite(tiling.anchor?.refLat) ||
      tiling.anchor.refLat <= -90 ||
      tiling.anchor.refLat >= 90
    ) {
      throw new Error(`manifest anchor for ${cityId} is outside geographic bounds`);
    }
    if (
      tiling.tilingPolicy !== "k-anon-floor" &&
      tiling.tilingPolicy !== "byte-budget" &&
      tiling.tilingPolicy !== "fixed-edge"
    ) {
      throw new Error(`manifest tilingPolicy for ${cityId} is invalid`);
    }
    if (
      (tiling.tilingPolicy === "k-anon-floor" && tiling.kAnonWaived !== false) ||
      (tiling.tilingPolicy !== "k-anon-floor" && tiling.kAnonWaived !== true)
    ) {
      throw new Error(`manifest k-anonymity waiver for ${cityId} is inconsistent`);
    }
    const bounds = validateTileBounds(cityId, tiling.tileBounds);
    const index = buildEntryIndex(cityId, entries, tiling.edgeKm, tiling.anchor);
    if (!index) throw new Error(`active POI corpus for ${cityId} is empty`);
    if (
      index.bounds.minX < bounds.minX ||
      index.bounds.maxX > bounds.maxX ||
      index.bounds.minY < bounds.minY ||
      index.bounds.maxY > bounds.maxY
    ) {
      throw new Error(`active POI corpus for ${cityId} falls outside tileBounds`);
    }
    if (
      tiling.tilingPolicy === "k-anon-floor" &&
      [...index.byCoords.values()].some((tileEntries) => tileEntries.length < TILE_MIN_K)
    ) {
      throw new Error(`active POI corpus for ${cityId} violates k=${TILE_MIN_K}`);
    }
    const width = bounds.maxX - bounds.minX + 1;
    const height = bounds.maxY - bounds.minY + 1;
    const cellCount = width * height;
    if (!Number.isSafeInteger(cellCount) || cellCount <= 0) {
      throw new Error(`manifest tileBounds for ${cityId} have invalid area`);
    }
    return {
      resolution: {
        status: "active",
        edgeKm: tiling.edgeKm,
        anchor: tiling.anchor,
        bounds,
        bundleSha256: record.sha256 as string,
      },
      cellCount,
    };
  }

  async function runPreflight(): Promise<boolean> {
    const manifest = await loadManifest();
    if (!manifest) return false;

    const nextTiling = new Map<string, CityTilingResolution>();
    const nextActiveRecords = new Map<string, PoiManifestBundle>();
    const seenStrict = new Set<string>();
    let aggregateCells = 0;

    for (const record of manifest.bundles) {
      if (record.filename !== `${record.cityId}.br`) continue;
      validateStrictRecord(record.cityId, record);
      if (seenStrict.has(record.cityId)) {
        throw new Error(`duplicate strict manifest record for ${record.cityId}`);
      }
      seenStrict.add(record.cityId);
      if (seenStrict.size > MAX_POI_CITY_SLOTS) {
        throw new Error(
          `manifest has more than ${MAX_POI_CITY_SLOTS} strict POI cities`,
        );
      }

      const tiling = record.poiTile;
      if (!tiling) {
        nextTiling.set(record.cityId, { status: "inactive" });
        continue;
      }
      if (typeof tiling.deliveryActive !== "boolean") {
        throw new Error(`manifest deliveryActive for ${record.cityId} must be boolean`);
      }
      if (!tiling.deliveryActive) {
        nextTiling.set(record.cityId, { status: "inactive" });
        continue;
      }
      const entries = await readCityBundle(record.cityId, record);
      const active = validateActiveTiling(record.cityId, record, entries);
      aggregateCells += active.cellCount;
      if (aggregateCells > responseCacheMaxEntries) {
        throw new Error(
          `POI tile cache holds ${responseCacheMaxEntries} entries but configured corpora expose ${aggregateCells} coordinates`,
        );
      }
      nextTiling.set(record.cityId, active.resolution);
      nextActiveRecords.set(record.cityId, record);
    }

    entriesCache.clear();
    entryLoads.clear();
    tilingCache.clear();
    activeRecords.clear();
    for (const [cityId, tiling] of nextTiling) tilingCache.set(cityId, tiling);
    for (const [cityId, record] of nextActiveRecords) {
      activeRecords.set(cityId, record);
    }
    preflightComplete = true;
    return true;
  }

  async function ensurePreflight(): Promise<boolean> {
    if (preflightFailure !== undefined) throw preflightFailure;
    if (preflightComplete) return true;
    if (!preflightPromise) {
      preflightPromise = runPreflight().catch((error: unknown) => {
        preflightFailure = error;
        throw error;
      });
    }
    try {
      return await preflightPromise;
    } finally {
      if (!preflightComplete && preflightFailure === undefined) {
        preflightPromise = null;
      }
    }
  }

  async function loadCityEntries(cityId: string): Promise<PoiEntry[] | null> {
    if (!CITY_ID_PATTERN.test(cityId) || !(await ensurePreflight())) return null;
    const cached = entriesCache.get(cityId);
    if (cached) return cached;
    const record = activeRecords.get(cityId);
    if (!record) return null;
    const inflight = entryLoads.get(cityId);
    if (inflight) return inflight;
    const load = readCityBundle(cityId, record).then((entries) => {
      entriesCache.set(cityId, entries);
      return entries;
    });
    entryLoads.set(cityId, load);
    try {
      return await load;
    } finally {
      entryLoads.delete(cityId);
    }
  }

  async function resolveCityTiling(cityId: string): Promise<CityTilingResolution> {
    if (!CITY_ID_PATTERN.test(cityId) || !(await ensurePreflight())) {
      return { status: "unknown" };
    }
    return tilingCache.get(cityId) ?? { status: "unknown" };
  }

  return {
    loadCityEntries,
    resolveCityTiling,
    preflight: ensurePreflight,
  };
}
