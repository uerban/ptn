import Dexie, { type EntityTable } from "dexie";
import type {
  BaseEndpoint,
  PoiEntry,
  GeocoderProviderId,
  LatLon,
  RoutingBundleFrequency,
  RouteDirectionPattern,
  TransportMode,
  LineInfo,
} from "@pt/shared";
import type { EncryptedRecord } from "../services/cryptoBox.ts";
import type { GbfsStationInformationRow } from "../services/gbfs/types.ts";
import { migrationCoordinator } from "./migrationCoordinator.ts";

// ── Existing tables ─────────────────────────────────────────────────────────

interface StopRecord {
  id: string;
  name: string;
  location: LatLon;
  parentStationId?: string;
  lastSeen: number;
  lines?: LineInfo[];
}

interface UsageStatRecord {
  stopId: string;
  tapCount: number;
  lastTapped: number;
}

// ── GTFS tables for client-side RAPTOR ──────────────────────────────────────

interface GtfsRouteRecord {
  id: string;
  shortName: string;
  mode: TransportMode;
  color?: string;
  textColor?: string;
  stopIds: string[];
  /**
   * Per-direction stop sequences carried by the Dexie display fallback.
   * Non-indexed; Dexie stores it as an opaque value on the row. Writers
   * omit the field when there are no patterns — never persist `[]`.
   */
  directionPatterns?: RouteDirectionPattern[];
}

interface GtfsTripRecord {
  tripId: string;
  routeId: string;
  serviceId: string;
  headsign: string;
  /** Optional GTFS timetable direction; non-indexed, so no Dexie version bump. */
  directionId?: 0 | 1;
  /** Optional PTB global trip ordinal carried by PTB-backed bundle paths. */
  ptbTripIdx?: number;
  departureSecs: number[];
  /**
   * Sparse per-stop dwell seconds, parallel to the enclosing route's
   * stopIds. Absent for the common zero-dwell case. Not indexed — Dexie
   * stores it as an opaque value on the row and RAPTOR uses it to derive
   * arrival_time at alight-time. Added without a schema version bump
   * because extra non-indexed fields are tolerated by Dexie.
   */
  dwellSecs?: number[];
  wheelchairAccessible?: number;
  bikesAllowed?: number;
  shapeId?: string;
}

interface GtfsShapeRecord {
  shapeId: string;
  encodedPolyline: string;
  source: "gtfs";
}

interface GtfsServiceRecord {
  serviceId: string;
  days: boolean[];
  startDate: string;
  endDate: string;
  exceptions: Record<string, number>;
}

interface GtfsSyncMeta {
  id: string; // always "current"
  cityId: string;
  etag: string;
  lastSynced: number;
  generatedAt: string;
  /** Rust generation paired with the PTB catalog. */
  generationId: string;
  /** Transfer sidecar paired with the derived bundle; absent when none exists. */
  transfersHash?: string;
  /** Shapes sidecar paired with the derived bundle; absent when none exists. */
  shapesHash?: string;
  /** Non-indexed copy of top-level GTFS frequencies.txt rows for the Dexie fallback. */
  frequencies?: RoutingBundleFrequency[];
}

interface GtfsStopRecord {
  id: string;
  name: string;
  lat: number;
  lon: number;
  wheelchairBoarding?: number;
}

/**
 * Stop groups for disambiguation in schedule-only mode (M3).
 * Groups same-name stops that represent the same physical location
 * but different platforms/directions.
 */
export interface StopGroupRecord {
  /** Parent group ID (either GTFS parent_station or generated) */
  groupId: string;
  /** Display name for the group */
  name: string;
  /** Child stop IDs belonging to this group */
  stopIds: string[];
  /** Group type */
  type: "parent_station" | "name_cluster" | "name_numbered";
  /** Center point of the group (average of child stop locations) */
  lat: number;
  lon: number;
}

/**
 * Row container for the install key. The key itself is a non-extractable
 * WebCrypto CryptoKey persisted via IndexedDB's structured-clone.
 */
export interface InstallKeyRecord {
  /** `current`: AES-GCM sealing key; `hmac`: keyed lookup identifiers. */
  id: "current" | "hmac";
  key: CryptoKey;
}

/**
 * Personal record at rest: an opaque random id plus ciphertext. Everything
 * else (endpoints, labels, timestamps, counts, stop IDs) is inside `sealed`;
 * see `services/personalStorage.ts`.
 */
export interface SealedPersonalRow {
  id: string;
  sealed: EncryptedRecord;
}

/**
 * Legacy row shape, read only by the encrypted-storage migration: rows are now
 * `SealedPersonalRow`s.
 *
 * Recent route endpoints (M8b). Endpoint coordinates live in `endpoint`, which
 * carries a `BaseEndpoint` at `plaintext` tier or an `EncryptedRecord` at
 * `encrypted` tier. Metadata (`id`, `usedAt`, `usedAsOrigin`) stays plaintext
 * so the table remains queryable for LRU eviction and TTL sweeps.
 * At `ram-only` tier records do not land in this table at all — see
 * `services/recents.ts`.
 */
export interface RecentLocationRecord {
  id: string;
  endpoint: BaseEndpoint | EncryptedRecord;
  usedAt: number;
  usedAsOrigin: boolean;
}

/**
 * Legacy row shape, read only by the encrypted-storage migration: rows are now
 * `SealedPersonalRow`s.
 *
 * Saved locations (M8c) — user-pinned places. Like recents, the endpoint is
 * polymorphic across encryption tier: a `BaseEndpoint` when stored plaintext,
 * an `EncryptedRecord` when sealed via cryptoBox. The plaintext metadata
 * (`alias`, `savedAt`, `pinColor`, `encrypted`) stays queryable for sort/list
 * UI; at Paranoid the `alias` migrates inside the encrypted payload (M8c T-22)
 * and `alias` here becomes a placeholder. The `encrypted` flag mirrors the
 * tier the row was written at so reads can dispatch without re-checking policy.
 *
 * Pair saves (M8c T-19 "Save this pair") populate `destinationEndpoint` with
 * the route destination; in that mode `endpoint` holds the origin. Single-
 * location saves (migrated favorites, map-tap saves) leave it unset.
 */
export interface SavedLocationRecord {
  id: string;
  endpoint: BaseEndpoint | EncryptedRecord;
  destinationEndpoint?: BaseEndpoint | EncryptedRecord;
  alias: string;
  /**
   * Sealed alias ciphertext. Populated at the `always-no-share` axis (Paranoid),
   * where the plaintext `alias` field is blanked and the label moves inside
   * this encrypted payload. Readers prefer `aliasCipher` when present.
   */
  aliasCipher?: EncryptedRecord;
  savedAt: number;
  pinColor?: string;
  encrypted: boolean;
}

// ── POI geocoder tables (M7c) ──────────────────────────────────────────────

export interface PoiIndexRecord {
  address?: PoiEntry["address"];
  id: string;
  cityId: string;
  name: string;
  geoBucket: string;
  aliases: Record<string, string[]>;
  category: string;
  lat: number;
  lon: number;
  source: "curated" | "osm";
  rankBoost: number;
  tier: "strict" | "loose";
  wikidataId?: string;
  nearestStopGroupId?: string | null;
  osmId?: string;
  // Distinguishes rows written by the bundle loader (undefined/"bundle")
  // from rows written by the viewport tile loader (M11 T-8 / T-9). Query-time
  // dedup in BundledGeocoderAdapter uses this to let bundle rows win.
  loadSource?: "bundle" | "tile";
  /** Strict POI bundle generation that produced this tile-derived row.
   * Non-indexed and absent on bundle rows. */
  bundleSha256?: string;
  /** Digest of the complete local tiling contract that produced this row.
   * Non-indexed and absent on bundle rows. */
  tileGenerationId?: string;
}

export interface PoiSyncMetaRecord {
  cityId: string;
  activationRevision?: number;
  activeBundleHash: string;
  entryCount: number;
  installedAt: number;
  tier: "strict" | "loose";
  sourcePbfTimestamp?: string;
  bundleGeneratedAt?: string;
}

// ── Geocoder dedup cache (M10 v2) ───────────────────────────────────────────

export interface GeocoderDedupRecord {
  queryHash: string;
  ct: ArrayBuffer;
  iv: ArrayBuffer;
  createdAt: number;
  providerId: GeocoderProviderId;
  gridMeters: number;
}

// ── POI tile cache (M11) ────────────────────────────────────────────────────

export interface PoiTileCacheRecord {
  /** Generation-qualified primary key: `<canonical tileKey>?v=<contract digest>`. */
  tileKey: string;
  compressedBytes: ArrayBuffer;
  loadedAt: number;
  byteSize: number;
  /** Non-indexed provenance copied from the active tile generation. */
  cityId: string;
  /** Non-indexed bundle digest copied from the active tile generation. */
  bundleSha256: string;
  /** Non-indexed complete-contract digest copied from the active tile generation. */
  generationId: string;
}

/** Last network-validated tiled-delivery contract for one POI city. This row
 * is both the offline manifest fallback and the transaction-time authority for
 * tile writes. */
export interface PoiTileGenerationRecord {
  cityId: string;
  generationId: string;
  bundleSha256: string;
  schemaVersion: number;
  edgeKm: number;
  anchor: {
    minLat: number;
    minLon: number;
    refLat: number;
  };
  tileBounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
  tilingPolicy: "k-anon-floor" | "byte-budget" | "fixed-edge";
  kAnonWaived: boolean;
  deliveryActive: boolean;
  /** Monotonic deployment activation; retained by disabled records too. */
  activationRevision?: number;
  /** Explicit manifest disable, unlike a retryable API resync. */
  activationDisabled?: boolean;
  validatedAt: number;
  /** Server manifest `generatedAt` (epoch ms) this generation was derived
   * from. Absent when the source manifest carried none. Monotonic
   * authority: `tileCache.activateTileGeneration` refuses to overwrite a
   * persisted record with a STRICTLY newer `manifestGeneratedAt` — closes
   * the race where a stale in-flight fetch (e.g. an edge/CDN-cached
   * manifest) resolves after a newer cross-tab release already activated.
   * Non-indexed; no Dexie version bump needed. */
  manifestGeneratedAt?: number;
}

// ── Address-search bundle cache ────────────────────────────────────────────

export interface AddressSearchArtifactRecord {
  cityId: string;
  sha256: string;
  sizeBytes: number;
  generatedAt: string;
  installedAt: number;
  rowCount: number;
  keyCount: number;
  source?: string;
  bundleGenerationId?: string;
  /**
   * The packed address artifact, verbatim. The bytes go straight to wasm,
   * which reads the index in place, so a cold start never structured-clones a
   * parsed object graph out of IndexedDB.
   */
  bytes: ArrayBuffer;
}

// ── GTFS bundle blob ────────────────────────────────────────────────────────

/**
 * Compressed canonical-shaped GTFS payload keyed by cityId. The bundle is
 * read once at startup and hydrated into RaptorIndex in memory; the Dexie
 * display tables remain available as a fallback for UI surfaces.
 *
 * `format` indicates the compression codec in case we ever need to evolve
 * it; the writer only emits "gzip" (via CompressionStream, no new deps).
 *
 * `compressedSize` / `decompressedSize` are recorded for observability —
 * they let us quantify the IDB footprint win without a storage-quota probe.
 */
export interface GtfsBundleRecord {
  cityId: string;
  compressedBytes: ArrayBuffer;
  format: "gzip" | "br";
  bundleGeneratedAt: string;
  compressedSize: number;
  decompressedSize: number;
  writtenAt: number;
}

/**
 * Transfer-artifact provenance for the pedestrian-transfer table that pairs
 * with the cached PTB bytes. Parsed from the `X-PT-Transfers-Artifact-*`
 * response headers of `GET /api/<city>/raptor-bundle` and persisted alongside
 * the PTB row so a later wasm transfer-attach can fetch + SHA-verify the
 * transfer bytes without re-decoding the routing bundle. `hash` is the
 * unquoted lowercase-hex sha256 of the transfer bytes (identical from the
 * Node route and pt-serve). `url` is the artifact fetch path; `sizeBytes` is
 * the uncompressed transfer-table byte length.
 */
export interface TransfersArtifactManifest {
  url: string;
  hash: string;
  sizeBytes: number;
}

/**
 * Raw PTB bytes cached per city. Populated by `services/gtfsBundleBytes.ts` after a successful
 * fetch of `GET /api/<city>/raptor-bundle`. Consumed by `services/raptorWasm.ts` for
 * PtRouter::new() construction.
 */
export interface PtbBytesRecord {
  cityId: string;
  /**
   * Raw PTB bytes. `Uint8Array` (not `ArrayBuffer` like sibling
   * `GtfsBundleRecord.compressedBytes`) because `pt-wasm`'s
   * `PtRouter::new(&[u8])` takes a typed-array view directly. Round-trips
   * through Dexie's structured-clone preserving the brand, BUT note: under
   * jsdom + fake-indexeddb the round-tripped view is cross-realm, so
   * `instanceof Uint8Array` returns false — use
   * `Object.prototype.toString.call(bytes) === "[object Uint8Array]"` for
   * realm-safe brand checks (see `tests/db/ptbBytes.test.ts`).
   */
  bytes: Uint8Array;
  /**
   * Exact ETag header value emitted by `GET /api/<city>/raptor-bundle`,
   * INCLUDING the outer double-quotes (RFC 7232 strong-validator format,
   * e.g. `"a3f9c2..."`). Round-tripped verbatim as `If-None-Match` on the
   * next fetch — a future caller that strips the quotes or otherwise
   * normalises this string will silently break the 304 fast-path and
   * re-download the full bytes every load. The format is
   * `sha256(bytes).slice(0, 32)` (16 bytes / 32 hex chars), produced in
   * `packages/backend/src/routes/raptorBundle.ts`.
   */
  etag: string;
  /**
   * Epoch milliseconds when this row was first stored (i.e. when the
   * full PTB bytes were last downloaded, not just revalidated). Not
   * updated on a 304 — use `lastValidatedAt` for that.
   */
  firstStoredAt: number;
  /**
   * Epoch milliseconds when this row was last confirmed fresh by the
   * server — either a 200 (newly downloaded) or a 304 (ETag matched).
   * Updated on every successful fetch attempt. Operators reading this
   * to debug cache age should prefer it over `firstStoredAt`.
   */
  lastValidatedAt: number;
  /**
   * Runtime service-bitmask window length (days) decoded from the cached PTB
   * header at store time (`readWindowProvenance(bytes).windowDays`). Default
   * `90` when the bundle carries no `0x01 WindowMeta` region (any feed whose
   * derived window is 90), OR when the bytes failed to
   * decode (the decode is best-effort and never blocks the persist).
   *
   * Non-indexed object property (the store indexes only `cityId`).
   * Provenance only: lets an operator triaging "rider sees
   * no service N months out" inspect what window the cached bundle carries.
   * NO UI surfaces it yet (deferred — separable presentation task).
   *
   * Every current write path populates this field. It is non-indexed because
   * it is diagnostic provenance rather than a query key.
   */
  windowDays: number;
  /**
   * The `YYYYMMDD` horizon end date this cached bundle's service window covers
   * = `feedStartDate + windowDays` (DST/TZ-invariant civil-date arithmetic).
   * Empty string when `feedStartDate` could not be decoded from the bytes (a
   * best-effort, non-indexed provenance field — see `windowDays`). Inspectable
   * for offline-device "how far out does cached service reach?" triage.
   */
  horizonEndDate: string;
  /**
   * IANA timezone of the generation that served these PTB bytes, read from
   * `X-PT-City-Tz-Iana`. Non-indexed and optional because a response may omit
   * the provenance header during a rolling server deployment.
   */
  cityTzIana?: string;
  /**
   * Transfer-artifact provenance emitted by GET /api/<city>/raptor-bundle
   * response headers. Non-indexed and optional when the generation has no
   * transfer artifact.
   */
  transfersArtifact?: TransfersArtifactManifest;
}

/**
 * Compressed schedule-tile bytes cached per `(bundleHash, tileSize, tileCoords)`.
 * Immutable content — keyed by the content-addressed bundle hash, so no ETag (C2).
 * `byteSize` drives the LRU budget; `key` prefix `${bundleHash}/` drives the
 * roll-prune (R20).
 */
export interface ScheduleTileCacheRecord {
  key: string; // `${bundleHash}/${tileSize}/${tileCoords}`
  compressedBytes: ArrayBuffer;
  loadedAt: number;
  byteSize: number;
}

// ── GBFS bike-share systems cache ───────────────────────────────────────────

/**
 * One cached bike-share station: the static-ish `station_information`
 * fields ONLY — positions/name/address/capacity. Deliberately carries NO
 * availability data (`num_bikes_available`, operational flags): stale
 * counts are worse than none, so live `station_status` is never persisted,
 * and its absence from this type makes persisting it a compile error rather
 * than a code-review catch. Offline consumers render these as position-only
 * grey markers (`offline-cached` state).
 *
 * An alias of the GBFS wire row (`services/gbfs/types.ts`) — the same type,
 * not a copy — so validated fetch results persist as-is (no mapper), cached
 * rows feed straight back into `mergeStations`, and any wire-type change
 * surfaces here as a compile error instead of silent drift.
 */
export type GbfsStationInfoRow = GbfsStationInformationRow;

/**
 * Cached station positions for one shared-mobility system in one city,
 * keyed `"<cityId>:<systemId>"` (e.g. `"vilnius:cyclocity"`). Written after
 * each successful `station_information` fetch; read on layer enable so
 * cached positions render before (or without) the live feed. Classified
 * `server-derived` in `TABLE_KIND` — a re-fetchable cache, wiped on
 * data-schema bumps and simply re-populated on the next enable.
 */
export interface GbfsSystemRow {
  key: string;
  /** Epoch ms when the station_information feed was fetched. */
  fetchedAt: number;
  stations: GbfsStationInfoRow[];
}

// ── Database ────────────────────────────────────────────────────────────────

export interface OfflineCityRecord {
  cityId: string;
  city: import("../config/cities.ts").CityConfig;
  preparedAt: number;
  sizeBytes: number;
  tables: Record<string, object[]>;
}
export interface OfflineTransferRecord { hash: string; bytes: Uint8Array }

interface PtnTables {
  offlineCities: EntityTable<OfflineCityRecord, "cityId">;
  offlineTransfers: EntityTable<OfflineTransferRecord, "hash">;
  stops: EntityTable<StopRecord, "id">;
  usageStats: EntityTable<UsageStatRecord, "stopId">;
  personalUsage: EntityTable<SealedPersonalRow, "id">;
  gtfsRoutes: EntityTable<GtfsRouteRecord, "id">;
  gtfsTrips: EntityTable<GtfsTripRecord, "tripId">;
  gtfsServices: EntityTable<GtfsServiceRecord, "serviceId">;
  gtfsSyncMeta: EntityTable<GtfsSyncMeta, "id">;
  gtfsStops: EntityTable<GtfsStopRecord, "id">;
  stopGroups: EntityTable<StopGroupRecord, "groupId">;
  installKey: EntityTable<InstallKeyRecord, "id">;
  recentLocations: EntityTable<SealedPersonalRow, "id">;
  savedLocations: EntityTable<SealedPersonalRow, "id">;
  poiIndex: EntityTable<PoiIndexRecord, "id">;
  poiSyncMeta: EntityTable<PoiSyncMetaRecord, "cityId">;
  geocoderDedup: EntityTable<GeocoderDedupRecord, "queryHash">;
  poiTileCache: EntityTable<PoiTileCacheRecord, "tileKey">;
  poiTileGenerations: EntityTable<PoiTileGenerationRecord, "cityId">;
  gtfsBundle: EntityTable<GtfsBundleRecord, "cityId">;
  gtfsShapes: EntityTable<GtfsShapeRecord, "shapeId">;
  ptbBytes: EntityTable<PtbBytesRecord, "cityId">;
  scheduleTileCache: EntityTable<ScheduleTileCacheRecord, "key">;
  gbfsSystems: EntityTable<GbfsSystemRow, "key">;
  addressSearchArtifacts: EntityTable<AddressSearchArtifactRecord, "cityId">;
}

export type PtnTableName = keyof PtnTables;
export type TableKind = "server-derived" | "user-owned";

/**
 * Classifies every Dexie table as server-derived (safe to wipe on a
 * data-schema bump) or user-owned (must survive every wipe). The
 * `satisfies Record<PtnTableName, TableKind>` clause forces a compile
 * error if a new table is added to `PtnTables` without classifying it
 * here — making the deployed/user-owned split a load-bearing
 * compile-time invariant rather than a doc-comment promise.
 *
 * Consumed by `dataSchemaVersion.ts` to derive the wipe set.
 */
export const TABLE_KIND = {
  stops: "server-derived",
  usageStats: "user-owned",
  personalUsage: "user-owned",
  gtfsRoutes: "server-derived",
  gtfsTrips: "server-derived",
  gtfsServices: "server-derived",
  gtfsSyncMeta: "server-derived",
  gtfsStops: "server-derived",
  stopGroups: "server-derived",
  installKey: "user-owned",
  recentLocations: "user-owned",
  savedLocations: "user-owned",
  poiIndex: "server-derived",
  poiSyncMeta: "server-derived",
  // Searches the rider made, keyed by an install-keyed HMAC.
  geocoderDedup: "user-owned",
  poiTileCache: "server-derived",
  poiTileGenerations: "server-derived",
  gtfsBundle: "server-derived",
  gtfsShapes: "server-derived",
  ptbBytes: "server-derived",
  scheduleTileCache: "server-derived",
  gbfsSystems: "server-derived",
  addressSearchArtifacts: "server-derived",
  offlineCities: "server-derived",
  offlineTransfers: "server-derived",
} as const satisfies Record<PtnTableName, TableKind>;

const db = new Dexie("ptn") as Dexie & PtnTables;

/** The complete Dexie schema: table → primary key and indexes. */
export const STORES = {
  offlineCities: "cityId",
  offlineTransfers: "hash",
  stops: "id, lastSeen",
  usageStats: "stopId",
  personalUsage: "id",
  gtfsRoutes: "id",
  gtfsTrips: "tripId, routeId",
  gtfsServices: "serviceId",
  gtfsSyncMeta: "id",
  gtfsStops: "id",
  stopGroups: "groupId, name",
  installKey: "id",
  recentLocations: "id",
  savedLocations: "id",
  poiIndex: "id, [cityId+name], [cityId+geoBucket]",
  poiSyncMeta: "cityId",
  geocoderDedup: "queryHash, [providerId+createdAt]",
  poiTileCache: "tileKey, loadedAt",
  gtfsBundle: "cityId",
  gtfsShapes: "shapeId",
  ptbBytes: "cityId",
  scheduleTileCache: "key, loadedAt",
  gbfsSystems: "key",
  poiTileGenerations: "cityId",
  addressSearchArtifacts: "cityId",
} as const satisfies Record<PtnTableName, string>;

// Register schema versions through the coordinator so a subsystem that adds a
// later version fails loudly on collision instead of silently overwriting
// another's declaration at runtime.
migrationCoordinator.reserve({
  id: "ptn",
  version: 1,
  stores: {
    ...Object.fromEntries(Object.entries(STORES).filter(([name]) => !["offlineCities", "offlineTransfers", "personalUsage"].includes(name))),
    // Version-1 shape of the personal tables (changed in version 3 below).
    usageStats: "stopId, lastTapped",
    recentLocations: "id, usedAt",
    savedLocations: "id, savedAt",
  },
});

migrationCoordinator.reserve({id: "offline-city-packages", version: 2,
  stores: {offlineCities: "cityId", offlineTransfers: "hash"}});

// Personal records keep only an opaque id outside their ciphertext, so their
// timestamp indexes go and stop usage moves to opaque-keyed rows. Rows are
// converted by services/personalStorageMigration.ts, not by this upgrade.
migrationCoordinator.reserve({id: "personal-encrypted-storage", version: 3,
  stores: {personalUsage: "id", recentLocations: "id", savedLocations: "id", usageStats: "stopId"}});

for (const decl of migrationCoordinator.declaredMigrations()) {
  const v = db.version(decl.version).stores(decl.stores);
  if (decl.upgrade) {
    v.upgrade((tx) => decl.upgrade!(tx));
  }
}

// An open connection must not remain as a stale writer when another tab
// upgrades the schema. IndexedDB blocks the upgrade until every older
// connection closes.
db.on("versionchange", () => {
  db.close();
});

// ── gbfsSystems helpers ─────────────────────────────────────────────────────

/** Composite primary key for `db.gbfsSystems`: `"<cityId>:<systemId>"`. */
function gbfsSystemKey(cityId: string, systemId: string): string {
  return `${cityId}:${systemId}`;
}

/**
 * Read the cached station positions for one city's shared-mobility system.
 * `undefined` when the system was never fetched on this device (or the
 * cache was wiped) — callers fall back to the `loading` path.
 */
export async function readGbfsSystem(
  cityId: string,
  systemId: string,
): Promise<GbfsSystemRow | undefined> {
  return db.gbfsSystems.get(gbfsSystemKey(cityId, systemId));
}

/**
 * Persist freshly fetched station positions for one city's system,
 * replacing any prior row for the same `cityId:systemId`. Accepts only
 * {@link GbfsStationInfoRow} — the positions-only persisted shape; live
 * availability never lands in Dexie by construction.
 */
export async function writeGbfsSystem(
  cityId: string,
  systemId: string,
  stations: readonly GbfsStationInfoRow[],
  fetchedAt: number = Date.now(),
): Promise<void> {
  await db.gbfsSystems.put({
    key: gbfsSystemKey(cityId, systemId),
    fetchedAt,
    stations: [...stations],
  });
}

export { db };
export type {
  StopRecord,
  UsageStatRecord,
  GtfsRouteRecord,
  GtfsTripRecord,
  GtfsServiceRecord,
  GtfsSyncMeta,
  GtfsStopRecord,
  GtfsShapeRecord,
};
export type { SavedLocationRecord as SavedRecord };
export type { EncryptedRecord } from "../services/cryptoBox.ts";
