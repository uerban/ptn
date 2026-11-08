import { readWindowProvenance } from "@pt/shared/ptb";
import { addDaysCivil } from "@pt/shared/util";
import { db } from "../db/index.ts";
import type { PtbBytesRecord, TransfersArtifactManifest } from "../db/index.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { shouldWriteShapes } from "./gtfsQuotaGuard.ts";

/**
 * Parse the transfer-artifact provenance headers emitted by
 * `GET /api/<city>/raptor-bundle`. Returns `undefined` unless all three of the
 * `X-PT-Transfers-Artifact-{Url,Hash,Size}` headers are present and the size
 * parses to a finite non-negative number — a served generation only emits them
 * when it actually has a transfers artifact. The `Hash` is the unquoted
 * lowercase-hex sha256 of the transfer bytes (identical from Node and pt-serve);
 * a later wasm transfer-attach uses it to SHA-verify the fetched bytes.
 */
function readTransfersArtifactHeaders(headers: Headers): TransfersArtifactManifest | undefined {
  const url = headers.get("x-pt-transfers-artifact-url");
  const hash = headers.get("x-pt-transfers-artifact-hash");
  const sizeRaw = headers.get("x-pt-transfers-artifact-size");
  if (!url || !hash || !sizeRaw) return undefined;
  const sizeBytes = Number(sizeRaw);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return undefined;
  return { url, hash, sizeBytes };
}

/**
 * True when the response came from a provenance-capable server (the capability
 * marker `X-PT-Raptor-Bundle-Provenance: transfers-v1` is ALWAYS present on
 * such a server, even when the served generation has no transfers artifact).
 * Distinguishes "capable server, no artifact ⇒ clear stale cache" from "old
 * replica with no capability header ⇒ preserve cache" during a rolling deploy.
 */
function hasTransfersProvenanceCapability(headers: Headers): boolean {
  return headers.get("x-pt-raptor-bundle-provenance") === "transfers-v1";
}

/**
 * Read and validate the authoritative IANA timezone of the served generation.
 * Absence is tolerated during the rolling server deploy; a present but invalid
 * value is a contract violation and must not be paired with cached PTB bytes.
 */
function readCityTzIana(headers: Headers): string | undefined {
  const value = headers.get("x-pt-city-tz-iana")?.trim();
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
  } catch {
    throw new Error("raptor-bundle: invalid X-PT-City-Tz-Iana header");
  }
  return value;
}

/**
 * Decode the window provenance for the bytes about to be persisted. Reuses the
 * shared TOTAL header-only decoder (`readWindowProvenance` — no full `loadPtb`
 * parse, no Node `Buffer`), so it never throws on the persist path: malformed
 * bytes degrade to `windowDays=90` / an empty `horizonEndDate`. `horizonEndDate`
 * is the `YYYYMMDD` of `feedStartDate + windowDays` via DST/TZ-invariant civil
 * arithmetic (empty when `feedStartDate` is absent). See `PtbBytesRecord`.
 *
 * NOTE (deliberate, do NOT "align"): this provenance horizon is `+ windowDays`
 * (the first-EXCLUDED day), one day later than `ptbToBundleWire`'s inclusive
 * wire `endDate` (`feedStartDate + windowDays - 1`, the last ACTIVE day). The two
 * formulas describe different quantities and are each correct for their use.
 */
function windowProvenanceFields(bytes: Uint8Array): {
  windowDays: number;
  horizonEndDate: string;
} {
  const { windowDays, feedStartDate } = readWindowProvenance(bytes);
  const horizonEndDate =
    feedStartDate > 0 ? addDaysCivil(String(feedStartDate), windowDays) : "";
  return { windowDays, horizonEndDate };
}

/**
 * Thrown when neither the network nor the IDB cache can produce PTB bytes
 * for a city. Callers should treat this as a hard "RAPTOR engine cannot
 * start" signal (no fallback to a stale haversine-only path). The original
 * trigger — network error, 304-without-cache, or empty body — is preserved
 * on `.cause` for diagnostics.
 */
export class PtbBytesUnavailableError extends Error {
  constructor(cityId: string, cause?: unknown) {
    super(`no PTB bytes available for city ${cityId}`);
    this.name = "PtbBytesUnavailableError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface FetchPtbBytesResult {
  bytes: Uint8Array;
  /**
   * Verbatim ETag header from the backend, INCLUDING the outer double-quotes
   * (RFC 7232 strong-validator format, e.g. `"a3f9c2..."`). Round-tripped
   * unmodified as `If-None-Match` on the next fetch — a future caller that
   * strips quotes or otherwise normalises this string will silently break
   * the 304 fast-path. See `PtbBytesRecord.etag` JSDoc in `db/index.ts`.
   */
  etag: string;
  /**
   * True when the bytes were served from IDB (either a 304 revalidation
   * hit OR a network-error fallback OR the prefer-cache fast-path).
   * False only when the bytes came from a fresh 200 response body.
   */
  fromCache: boolean;
  /**
   * True only when this call received a successful 200/304 response from the
   * bundle endpoint. Unlike `fromCache`, this distinguishes a validated 304
   * cache hit from an offline/error/prefer-cache fallback. Catalog sync uses it
   * to avoid pairing stale PTB bytes with a newer `/ready` generation.
   */
  networkValidated: boolean;
  /**
   * Platform-validated IANA timezone carried by the same 200/304 response as
   * these bytes. Undefined when the response omits the optional provenance
   * header; catalog sync cross-checks a present value against `/ready`.
   */
  cityTzIana?: string;
  /**
   * Transfer-artifact provenance for the pedestrian-transfer table paired with
   * these bytes, parsed from the `X-PT-Transfers-Artifact-*` response headers
   * and persisted on the cache row. Undefined when the served generation has
   * no transfers artifact. A later wasm transfer-attach consumes this to
   * fetch + SHA-verify the transfer bytes.
   */
  transfersArtifact?: TransfersArtifactManifest;
  /**
   * True when a provenance-CAPABLE server AUTHORITATIVELY resolved the transfer
   * state for these bytes — i.e. `transfersArtifact` reflects the served
   * generation exactly (present ⇒ this manifest; absent ⇒ this generation has
   * NO transfers). False when the state is INDETERMINATE: an offline/error
   * cache fallback, a server response without the capability header, or a
   * prefer-cache hit with no network round-trip. The wasm transfer-attach uses
   * this to decide whether an ABSENT artifact may bridge from the cached
   * bundle manifest (indeterminate ⇒ yes) or must stay haversine
   * (authoritative "no transfers" ⇒ no stale manifest is attached).
   */
  transfersResolved: boolean;
}

const QUOTA_EXCEEDED = "QuotaExceededError";

function isQuotaExceeded(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: unknown }).name === QUOTA_EXCEEDED;
}

/**
 * Persist freshly-downloaded bytes (200 path). On a 200 we always overwrite
 * the row, so `firstStoredAt === lastValidatedAt === now`. Swallows
 * `QuotaExceededError` so a near-quota PWA still gets a usable engine for
 * the current session — the bytes are returned in-memory regardless.
 * Sibling consumers (`installKey.ts`, `poiLoader.ts`) follow the same
 * shape. Any other error rethrows: a corrupt schema or bug in our code
 * should NOT be silently masked as "quota".
 */
async function persistFreshBytes(
  cityId: string,
  bytes: Uint8Array,
  etag: string,
  cityTzIana: string | undefined,
  transfersArtifact: TransfersArtifactManifest | undefined,
): Promise<void> {
  const now = Date.now();
  const { windowDays, horizonEndDate } = windowProvenanceFields(bytes);
  try {
    await db.ptbBytes.put({
      cityId,
      bytes,
      etag,
      firstStoredAt: now,
      lastValidatedAt: now,
      windowDays,
      horizonEndDate,
      cityTzIana,
      transfersArtifact,
    });
  } catch (err) {
    if (isQuotaExceeded(err)) {
      // Degrade silently — caller still receives in-memory bytes. Next
      // visit retries; if quota clears, the put succeeds then.
      console.warn(`[gtfsBundleBytes] IDB quota exceeded for ${cityId} PTB bytes — using in-memory only`, err);
      return;
    }
    throw err;
  }
}

/**
 * 304 path: server confirmed our cache is fresh. Only `lastValidatedAt`
 * advances; `firstStoredAt`, `etag`, `bytes` are untouched.
 *
 * Uses `put({...cached, lastValidatedAt})` rather than the seemingly-
 * cheaper `Table.update(key, {lastValidatedAt})`. The trade-off:
 *
 *   - `Table.update` LOOKS atomic but Dexie implements it as a
 *     get→merge→put under the hood (IndexedDB has no partial-update
 *     primitive), so the wire-level cost is identical.
 *   - `Table.update` MANGLES the stored `Uint8Array` under fake-indexeddb
 *     (cross-realm clone artifact — the merged row's `bytes` field comes
 *     back from get() as a cross-realm typed-array, and fake-indexeddb's
 *     polyfill of structured-clone serialises it as `{}` on the
 *     re-put). Real browsers handle this correctly, but every test that
 *     reads bytes after a 304 fails. See `PtbBytesRecord` JSDoc for the
 *     cross-realm-clone caveat.
 *   - `put` with the already-in-memory `cached` row is realm-safe (the
 *     in-memory view was the one we passed to the caller, not the one
 *     just read back).
 *
 * We accept the (irrelevant) read-modify-write race on a timestamp: two
 * concurrent 304s racing means one of two near-identical `lastValidatedAt`
 * values wins — semantically a no-op.
 */
async function touchValidated(
  cityId: string,
  cached: Pick<
    PtbBytesRecord,
    "bytes" | "etag" | "firstStoredAt" | "windowDays" | "horizonEndDate" | "cityTzIana"
  >,
  cityTzIana: string | undefined,
  transfersArtifact: TransfersArtifactManifest | undefined,
): Promise<void> {
  try {
    await db.ptbBytes.put({
      cityId,
      bytes: cached.bytes,
      etag: cached.etag,
      firstStoredAt: cached.firstStoredAt,
      lastValidatedAt: Date.now(),
      windowDays: cached.windowDays,
      horizonEndDate: cached.horizonEndDate,
      cityTzIana,
      // Resolved by the 304 caller per the rolling-deploy capability semantics:
      // `undefined` here intentionally clears a stale manifest (the whole row is
      // replaced by this put).
      transfersArtifact,
    });
  } catch (err) {
    if (isQuotaExceeded(err)) {
      // Already in IDB; quota error on a same-size re-put is implausible
      // but harmless to swallow — the timestamp drift is non-load-bearing.
      return;
    }
    // Non-fatal: failing to update a timestamp must not break a
    // fully-functional 304 fast-path.
    console.warn(`[gtfsBundleBytes] failed to update lastValidatedAt for ${cityId}`, err);
  }
}

/**
 * Network-first fetch. Sends `If-None-Match` from a prior IDB record; returns cached bytes on
 * 304. Falls back to cache on network error. Throws `PtbBytesUnavailableError` when neither
 * network nor cache produce bytes. The IDB persist is gated by `shouldWriteShapes()` (panel DB
 * F4: inherits the cache-poison-era quota guard so a near-quota PWA doesn't OOM on PTB persist;
 * in-memory bytes are still returned for the current session even when persist is skipped).
 */
// Same in-flight dedupe pattern as walkRouteCache.ts. The map key is the cityId so concurrent calls
// for different cities don't conflate.
const inFlight = new Map<string, Promise<FetchPtbBytesResult>>();

export interface FetchPtbBytesOptions {
  cached?: FetchPtbBytesResult;
  /** Artifact activation owns durability separately from byte acquisition. */
  persist?: boolean;
}

export async function fetchPtbBytes(cityId: string, options: FetchPtbBytesOptions = {}): Promise<FetchPtbBytesResult> {
  const key = JSON.stringify([cityId, options.persist !== false, options.cached?.etag,
    options.cached?.transfersArtifact?.hash, options.cached?.cityTzIana]);
  const ongoing = inFlight.get(key);
  if (ongoing) return ongoing;
  const promise = doFetchPtbBytes(cityId, options).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

async function doFetchPtbBytes(cityId: string, options: FetchPtbBytesOptions): Promise<FetchPtbBytesResult> {
  const apiUrl = `/api/${cityId}/raptor-bundle`;
  const cached: PtbBytesRecord | undefined = options.cached ? {
    cityId, bytes: options.cached.bytes, etag: options.cached.etag,
    cityTzIana: options.cached.cityTzIana, transfersArtifact: options.cached.transfersArtifact,
    firstStoredAt: Date.now(), lastValidatedAt: 0, ...windowProvenanceFields(options.cached.bytes),
  } : await db.ptbBytes.get(cityId);

  let res: Response;
  try {
    res = await fetch(apiUrl, {
      headers: cached ? new Headers({ "If-None-Match": cached.etag }) : new Headers(),
    });
  } catch (err) {
    // Network failure → cache fallback: we never reached a capable server, so
    // the transfer state is INDETERMINATE (the cached manifest may be stale).
    if (cached) return {
      bytes: cached.bytes,
      etag: cached.etag,
      fromCache: true,
      networkValidated: false,
      ...(cached.cityTzIana ? { cityTzIana: cached.cityTzIana } : {}),
      transfersArtifact: cached.transfersArtifact,
      transfersResolved: false,
    };
    throw new PtbBytesUnavailableError(cityId, err);
  }

  if (res.status === 304) {
    if (cached) {
      // Resolve the transfer manifest under the rolling-deploy capability rule:
      // parsed headers win; else a provenance-capable server that sent no
      // transfer headers ⇒ clear stale (`undefined`); else a server without
      // the capability header ⇒ preserve the cached manifest.
      const parsedTransfersArtifact = readTransfersArtifactHeaders(res.headers);
      const capable = hasTransfersProvenanceCapability(res.headers);
      const transfersArtifact = parsedTransfersArtifact
        ?? (capable ? undefined : cached.transfersArtifact);
      const cityTzIana = readCityTzIana(res.headers) ?? cached.cityTzIana;
      if (options.persist !== false) await touchValidated(cityId, cached, cityTzIana, transfersArtifact);
      // Only a capable server's answer is authoritative — a preserved cached
      // manifest leaves the state indeterminate.
      return {
        bytes: cached.bytes,
        etag: cached.etag,
        fromCache: true,
        networkValidated: true,
        ...(cityTzIana ? { cityTzIana } : {}),
        transfersArtifact,
        transfersResolved: capable,
      };
    }
    // Server bug: 304 with no client cache. Refuse rather than cache 0 bytes.
    throw new PtbBytesUnavailableError(cityId, new Error("304 without cached record"));
  }
  if (!res.ok) {
    // Server error → cache fallback: indeterminate, same as the network-error path.
    if (cached) return {
      bytes: cached.bytes,
      etag: cached.etag,
      fromCache: true,
      networkValidated: false,
      ...(cached.cityTzIana ? { cityTzIana: cached.cityTzIana } : {}),
      transfersArtifact: cached.transfersArtifact,
      transfersResolved: false,
    };
    throw new PtbBytesUnavailableError(cityId);
  }

  const etag = res.headers.get("etag") ?? "";
  const cityTzIana = readCityTzIana(res.headers);
  let bytes: Uint8Array;
  try {
    const buf = await res.arrayBuffer();
    bytes = new Uint8Array(buf);
  } catch (err) {
    // Partial/aborted body — fall back to cache rather than persist garbage.
    if (cached) return {
      bytes: cached.bytes,
      etag: cached.etag,
      fromCache: true,
      networkValidated: false,
      ...(cached.cityTzIana ? { cityTzIana: cached.cityTzIana } : {}),
      transfersArtifact: cached.transfersArtifact,
      transfersResolved: false,
    };
    throw new PtbBytesUnavailableError(cityId, err);
  }

  if (bytes.length === 0) {
    if (cached) return {
      bytes: cached.bytes,
      etag: cached.etag,
      fromCache: true,
      networkValidated: false,
      ...(cached.cityTzIana ? { cityTzIana: cached.cityTzIana } : {}),
      transfersArtifact: cached.transfersArtifact,
      transfersResolved: false,
    };
    throw new PtbBytesUnavailableError(cityId, new Error("backend returned empty body"));
  }

  // A fresh 200 replaces the whole row, so there is no capability-preserve
  // dance here — store exactly what the headers say (possibly `undefined`). A
  // capable server's 200 authoritatively resolves the transfer state.
  const transfersArtifact = readTransfersArtifactHeaders(res.headers);
  const transfersResolved = hasTransfersProvenanceCapability(res.headers);
  if (options.persist !== false && await shouldWriteShapes()) {
    await persistFreshBytes(cityId, bytes, etag, cityTzIana, transfersArtifact);
  }

  return {
    bytes,
    etag,
    fromCache: false,
    networkValidated: true,
    ...(cityTzIana ? { cityTzIana } : {}),
    transfersArtifact,
    transfersResolved,
  };
}

/**
 * Prefer-cache variant (panel DB F2): returns cached bytes WITHOUT a
 * network call when the cache exists. Used by the visibility-guard
 * recovery path (`services/wasmLifecycle.ts`) so resume-time
 * re-instantiation doesn't pay a full network round-trip for a known-
 * good local copy. Falls back to `fetchPtbBytes` when cache is empty.
 */
export async function fetchPtbBytesPreferCache(cityId: string): Promise<FetchPtbBytesResult> {
  const cached = await db.ptbBytes.get(cityId);
  // No network round-trip → the transfer state is indeterminate (the cached
  // manifest may be stale), so the attach can use the bundle manifest when
  // this row carries no manifest.
  if (cached) return {
    bytes: cached.bytes,
    etag: cached.etag,
    fromCache: true,
    networkValidated: false,
    ...(cached.cityTzIana ? { cityTzIana: cached.cityTzIana } : {}),
    transfersArtifact: cached.transfersArtifact,
    transfersResolved: false,
  };
  return fetchPtbBytes(cityId);
}

/** Evict cached bytes for a city — called on city switch (panel DB F3). */
export async function evictPtbBytes(cityId: string): Promise<void> {
  await db.ptbBytes.delete(cityId);
}

export function fetchPtbBytesForActiveCity(): Promise<FetchPtbBytesResult> {
  return fetchPtbBytes(useCityStore.getState().activeCity.id);
}
