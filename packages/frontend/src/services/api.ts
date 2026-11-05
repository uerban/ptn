import { BUNDLE_HASH_HEADER } from "@pt/shared/schedule-tile";
import type {
  Stop,
  Departure,
  Alert,
  HealthStatus,
  ApiResponse,
  RoutingBundleShape,
  RtRouteUpdate,
  ColorConfig,
  BundleManifest,
  RtTileResponse,
  PlanRequest,
  RaptorItinerary,
} from "@pt/shared";

import { useCityStore } from "../stores/cityStore.ts";
import { reportTelemetry } from "./errorReporter.ts";

function getBaseUrl(): string {
  return useCityStore.getState().getApiUrl();
}

function friendlyErrorMessage(status: number): string {
  if (status === 502 || status === 504) {
    return "Backend is starting up or unavailable. Please wait a moment and try again.";
  }
  if (status === 503) {
    return "Transit data is still loading. Please wait a moment.";
  }
  return `API error ${status}`;
}

/**
 * Thrown by `fetchJson` on any non-OK HTTP status. Callers that need to
 * branch on the status code (e.g. short-circuiting retries on 429) can
 * `instanceof`-check rather than parsing the message string.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Thrown when the server returns a 200 whose body is not JSON — the classic
 * "gateway HTML leaking through while the backend is starting" shape. Typed so
 * retry logic can treat it as startup-class without string-matching.
 */
export class BackendStartingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendStartingError";
  }
}

export async function fetchJson<T>(
  path: string,
  params?: Record<string, string>,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }
  const init: RequestInit = {};
  if (signal) init.signal = signal;
  if (headers) init.headers = headers;
  const res = await fetch(url.toString(), Object.keys(init).length > 0 ? init : undefined);
  // Do not re-introduce `serverTime.update(res.headers.get("Date"))` here.
  // Routes handled by `fetchJson` are NetworkFirst in the SW config
  // (`vite.config.ts` → `VitePWA.workbox.runtimeCaching`); a cache-fallback
  // response carries the original Date header from when it was first
  // stored — up to 24h stale for /stops/*. Time sync lives on
  // `useServerTimeSync` (mounted at the app root), which hits the only
  // NetworkOnly route (/version) and so always sees a fresh Date.
  return handleJsonResponse<T>(res, url, signal);
}

/**
 * Shared response tail for `fetchJson`/`postJson`. Re-checks abort, throws
 * `HttpError` on a non-OK status (using the JSON `error.message` when present),
 * throws `BackendStartingError` on a non-JSON 200 (gateway HTML leaking through
 * while the backend boots), otherwise parses and returns the JSON body.
 */
async function handleJsonResponse<T>(
  res: Response,
  url: URL,
  signal?: AbortSignal,
): Promise<T> {
  // Browsers can reject `res.json()` with non-AbortError shapes when a signal
  // aborts mid-body — re-check explicitly so callers see a consistent abort.
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!res.ok) {
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const errBody = await res.json();
      const msg = typeof errBody?.error?.message === "string" && errBody.error.message.length > 0
        ? errBody.error.message
        : friendlyErrorMessage(res.status);
      throw new HttpError(res.status, msg);
    }
    throw new HttpError(res.status, friendlyErrorMessage(res.status));
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    console.warn(`Expected JSON from ${url.pathname} but got ${ct}`);
    throw new BackendStartingError("Unexpected response from server. The backend may still be starting.");
  }
  const parsed = await res.json() as T;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return parsed;
}

/**
 * POST sibling of `fetchJson`: sends a JSON body with a
 * `Content-Type: application/json` header, then runs the shared
 * `handleJsonResponse` tail (abort re-checks, non-OK → `HttpError`, non-JSON
 * 200 → `BackendStartingError`). The caller passes an already-resolved path.
 */
async function postJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(path, window.location.origin);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  return handleJsonResponse<T>(res, url, signal);
}

export const api = {
  /**
   * Per-stop departures: schedule rows plus a live GTFS-RT overlay.
   *
   * Targets pt-serve's `GET /api/<city>/departures-for-stop`. It used to target
   * the Node route `GET /api/<city>/departures`, which is being retired —
   * the legacy departures retirement notes step 4. This is the whole of
   * the client half of that move: the caller-facing signature, the fallback,
   * the hedge and the `schedule_tile_*` telemetry are all unchanged, so the
   * only thing that moves is the URL and the parameter spelling.
   *
   * The signature stays in legacy terms (`time` / `limit` / `lookAheadHours`)
   * because every caller already speaks them and they read better at the call
   * site than raw unix seconds. Translation to the new route's
   * `from` / `to` / `maxResults` happens here, once.
   */
  getDepartures(
    stopId: string,
    time?: string,
    limit?: number,
    lookAheadHours?: number,
  ): Promise<ApiResponse<Departure[]>> {
    // `from` is REQUIRED by the new route, where legacy's `time` was optional
    // and defaulted SERVER-side. So the window origin is now the client clock.
    // That is not a new class of bug here: the schedule-tile read path — the
    // DEFAULT departures source, which this call only backstops — already
    // derives its window from `new Date()` in the browser. Sourcing both from
    // the same clock makes the fallback agree with the path it falls back from,
    // where deferring to the server clock would have made them disagree by
    // exactly the client's skew.
    const from = Math.floor((time ? new Date(time).getTime() : Date.now()) / 1000);
    const params: Record<string, string> = { stopId, from: String(from) };
    // `to` is EXCLUSIVE and defaults to `from + 1h` server-side. Legacy's
    // default was the same 1h (routes/departures.ts:110, `parsedLookAhead ?? 1`),
    // so omitting `to` preserves current behaviour exactly — see the
    // "omitted look-ahead" note in the retirement plan, which this closes.
    //
    // Fractional hours are supported (Home.tsx passes 1.5) because the wire
    // param is an instant, not an hour count.
    //
    // CEILING: the route rejects `to - from > 24h` with a 400, where legacy
    // accepted up to 48. DepartureSheet asks for exactly 24, which the route
    // accepts (its check is `>`, not `>=`) — so shipped callers fit, but they
    // fit EXACTLY. Anything asking for more than 24h needs the route's
    // MAX_WINDOW_SECS raised first, not a silent clamp here: clamping would
    // hand back a shorter window than asked for with no way to tell.
    if (lookAheadHours != null) {
      params.to = String(from + Math.round(lookAheadHours * 3600));
    }
    // Legacy defaulted `limit` to 20, or 100 when a look-ahead was given
    // (routes/departures.ts:109); the new route defaults to 100 flat. Send it
    // explicitly so a caller that omits `limit` keeps the legacy default rather
    // than silently widening to 100. Today's callers always pass it.
    params.maxResults = String(limit ?? (lookAheadHours != null ? 100 : 20));
    // No `x-pt-sw-version` header. It existed solely to bucket
    // `pt_legacy_departures_request_total{sw_version_bucket}` for the legacy
    // route's retirement gate; pt-serve does not read it, and after this change
    // nothing sends traffic to the route that did.
    //
    // The response envelope needs no translation — both routes return
    // `{ data, meta }` over the shared `Departure` interface. Only `meta`
    // differs (the new route adds `generationId`, `windowStart`, `windowEnd`,
    // `truncated`, `windowOutsideServiceRange`, `realtimeApplied`), and no
    // caller reads it, so `ApiResponse`'s `meta` is deliberately left
    // describing the legacy shape rather than grown for fields nothing uses.
    return fetchJson(`${getBaseUrl()}/departures-for-stop`, params);
  },

  getNearbyStops(
    lat: number,
    lon: number,
    radius?: number,
    limit?: number
  ): Promise<ApiResponse<Stop[]>> {
    const params: Record<string, string> = {
      lat: String(lat),
      lon: String(lon),
    };
    if (radius) params.radius = String(radius);
    if (limit) params.limit = String(limit);
    return fetchJson(`${getBaseUrl()}/stops/nearby`, params);
  },

  getAllStops(opts: { bypassCache?: boolean } = {}): Promise<ApiResponse<Stop[]>> {
    const params: Record<string, string> = {};
    // bypassCache appends a per-call cache-buster so the Workbox NetworkFirst
    // strategy in vite.config.ts can't return a previously-cached (possibly
    // poisoned `{data:[]}`) response — the cache key includes the query string,
    // so a unique param guarantees a miss and a fresh network fetch.
    if (opts.bypassCache) params._r = String(Date.now());
    return fetchJson(`${getBaseUrl()}/stops/all`, params);
  },

  searchStops(query: string, signal?: AbortSignal): Promise<ApiResponse<Stop[]>> {
    return fetchJson(`${getBaseUrl()}/stops/search`, { q: query }, signal);
  },

  getAlerts(): Promise<ApiResponse<Alert[]>> {
    return fetchJson(`${getBaseUrl()}/alerts`);
  },

  getHealth(): Promise<HealthStatus> {
    return fetchJson(`${getBaseUrl()}/health`);
  },

  async fetchRouteRt(routeId: string): Promise<RtRouteUpdate> {
    const url = new URL(`${getBaseUrl()}/rt/${routeId}`, window.location.origin);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(friendlyErrorMessage(res.status));
    const buffer = await res.arrayBuffer();
    const { decodeRouteUpdate } = await import("@pt/shared/proto");
    return decodeRouteUpdate(new Uint8Array(buffer));
  },

  /**
   * Backend-assist fallback planner: `POST /api/<city>/plan` → pt-serve's full
   * multi-round RAPTOR. `getBaseUrl()` already yields `/api/<city>`. A `200`
   * parses to `RaptorItinerary[]` (`200 []` → `[]`); a non-2xx (400/500) or a
   * network error throws (the caller catches → `[]`).
   */
  async plan(req: PlanRequest): Promise<RaptorItinerary[]> {
    return postJson<RaptorItinerary[]>(`${getBaseUrl()}/plan`, req);
  },

  /**
   * Fire-and-forget opt-in engine-failure report. POSTs to the city base; nginx
   * passes the city-scoped route directly to pt-serve. Never throws — reporting
   * must not break the failure UI. `keepalive` lets it survive a navigation.
   */
  async sendClientReport(report: unknown): Promise<void> {
    try {
      await fetch(`${getBaseUrl()}/client-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
        keepalive: true,
      });
    } catch {
      /* fire-and-forget; swallow */
    }
  },

  getColorConfig(): Promise<ColorConfig> {
    return fetchJson(`${getBaseUrl()}/color-config`);
  },

  async fetchShapesArtifact(
    url: string,
    expectedHash: string,
  ): Promise<{ shapes: RoutingBundleShape[]; hash: string }> {
    const absolute = new URL(url, window.location.origin).toString();
    const res = await fetch(absolute);
    if (!res.ok) throw new Error(`shapes artifact HTTP ${res.status}`);
    const body = await res.text();
    const hash = await sha256Hex(body);
    if (hash !== expectedHash) {
      throw new Error(`shapes artifact hash mismatch: got ${hash}, expected ${expectedHash}`);
    }
    const parsed = JSON.parse(body) as { shapes: RoutingBundleShape[] };
    return { shapes: parsed.shapes, hash };
  },
};

async function sha256Hex(body: string): Promise<string> {
  const data = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Schedule-tile manifest + tile fetchers (Part 2b-2) ───────────────────────

export interface FetchManifestResult {
  manifest: BundleManifest;
  etag: string | null;
  bundleHash: string | null;
  fromCache: boolean;
}

/**
 * Distinguishable cold-start error: thrown by `fetchManifest` when the server
 * returns 503 and no cached manifest is available (R17/C2). Callers that can
 * tolerate a stale cache reuse it; callers on cold start must surface this.
 */
export class ManifestUnavailableError extends Error {
  constructor() {
    super("manifest unavailable");
    this.name = "ManifestUnavailableError";
  }
}

/**
 * GET /api/<city>/gtfs/manifest. Sends If-None-Match from `cached.etag`; a 304
 * reuses `cached.manifest`; a 503 reuses the cache (breadcrumb) or throws a
 * distinguishable ManifestUnavailableError on cold start (R17/C2).
 */
export async function fetchManifest(
  cached?: { manifest: BundleManifest; etag: string | null },
): Promise<FetchManifestResult> {
  const res = await fetch(`${getBaseUrl()}/gtfs/manifest`, {
    headers: cached?.etag ? new Headers({ "If-None-Match": cached.etag }) : new Headers(),
  });
  const bundleHash = res.headers.get(BUNDLE_HASH_HEADER);
  if (res.status === 304 && cached) {
    return { manifest: cached.manifest, etag: cached.etag ?? null, bundleHash, fromCache: true };
  }
  if (res.status === 503) {
    if (cached) {
      reportTelemetry("manifest_unavailable_reused_cache", { status: 503 });
      return { manifest: cached.manifest, etag: cached.etag ?? null, bundleHash, fromCache: true };
    }
    throw new ManifestUnavailableError();
  }
  if (!res.ok) throw new HttpError(res.status, friendlyErrorMessage(res.status));
  const manifest = (await res.json()) as BundleManifest;
  return { manifest, etag: res.headers.get("ETag"), bundleHash, fromCache: false };
}

export interface FetchScheduleTileResult {
  status: number;
  bytes?: ArrayBuffer;
  bundleHash?: string;
  leaves?: string[];
}

/**
 * GET the schedule tile. Returns raw (still-compressed) bytes on 200. Does not
 * send If-None-Match — the cache key (bundleHash, tileSize, coord) is
 * content-immutable (C2). On 409/429 returns the bundle-hash header so the caller
 * can refresh; on tile_subdivided 404 returns the inlined `leaves` array.
 */
export async function fetchScheduleTile(
  bundleHash: string,
  tileSize: string,
  tileCoords: string,
): Promise<FetchScheduleTileResult> {
  const res = await fetch(
    `${getBaseUrl()}/gtfs/schedule-tile/${bundleHash}/${tileSize}/${tileCoords}`,
  );
  const hash = res.headers.get(BUNDLE_HASH_HEADER) ?? undefined;
  if (res.status === 200) return { status: 200, bytes: await res.arrayBuffer(), bundleHash: hash };
  if (res.status === 409 || res.status === 429) return { status: res.status, bundleHash: hash };
  if (res.status === 404) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; leaves?: string[] };
    return body.error === "tile_subdivided"
      ? { status: 404, leaves: body.leaves ?? [], bundleHash: hash }
      : { status: 404, bundleHash: hash };
  }
  return { status: res.status, bundleHash: hash };
}

export interface FetchRtTileResult { status: number; body?: RtTileResponse }

/**
 * GET the rt-tile. Never throws — any non-200 status is returned as-is;
 * network errors return `{status: 0}`.
 *
 * Status map (J13):
 *   200 → `{status: 200, body}` (parsed RtTileResponse)
 *   409 → `{status: 409}` — covers both `bundle_hash_mismatch` and
 *          `bundle_unavailable` (the rt-tile route folds both into 409)
 *   any other non-200 / network throw → `{status}` / `{status: 0}`
 */
export async function fetchRtTile(
  bundleHash: string,
  tileSize: string,
  tileCoords: string,
): Promise<FetchRtTileResult> {
  try {
    const res = await fetch(`${getBaseUrl()}/gtfs/rt-tile/${bundleHash}/${tileSize}/${tileCoords}`);
    if (res.status === 200) return { status: 200, body: (await res.json()) as RtTileResponse };
    return { status: res.status }; // 409 (mismatch OR unavailable) / 404 / 400 / 503 — all rt-unavailable
  } catch { return { status: 0 }; } // network — never throws
}
