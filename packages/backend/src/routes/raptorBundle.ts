import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { gzip as gzipCb } from "node:zlib";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const gzipAsync = promisify(gzipCb);

/**
 * GET /api/<city>/raptor-bundle — raw PTB bytes consumed by pt-wasm's PtRouter::new(). Mirrors
 * the pt-serve endpoint of the same name (crates/pt-serve/tests/server.rs:572-598).

 *
 * Routing: the Fastify route is `/api/raptor-bundle` because nginx strips
 * the `/api/<city>/` prefix to `/api/` before proxying (same convention as
 * routes/transfers.ts). The `<city>` slug is asserted by plugins/cityGuard
 * against the operator-supplied `CITY_ID` env — this handler is therefore
 * single-tenant by deployment. Multi-tenant deployments would need a
 * Map<path, CachedBundle> instead of the single closure slot below.
 *
 * Bytes source is `PT_BUNDLE_PATH`, the same env var the GTFS sidecar
 * consumes. When unset or the file is missing/empty/unreadable, returns 503 with three distinct
 * codes so operators can triage (env wrong vs. file broken vs. file empty).
 *
 * Cache: bytes + gzipped bytes + ETag live in a closure slot, invalidated
 * on `(path | mtime | size)` change. ETag is the sha256 of the file
 * CONTENTS (not mtime+size — mtime collisions are real for atomic-rename
 * regenerations that preserve attrs). gzip runs off the libuv thread pool
 * so a 5 MB cold miss doesn't block /health and /api/plan for 100-500 ms.
 * Concurrent cold requests share an in-flight promise so we only do the
 * hash+gzip work once per cache generation.
 */

interface CachedBundle {
  path: string;
  mtimeMs: number;
  size: number;
  contentEtag: string;
  raw: Buffer;
  gz: Buffer;
}

export interface TransfersArtifactMeta {
  url: string;
  hash: string;
  sizeBytes: number;
}

const TRANSFERS_URL_HEADER = "X-PT-Transfers-Artifact-Url";
const TRANSFERS_HASH_HEADER = "X-PT-Transfers-Artifact-Hash";
const TRANSFERS_SIZE_HEADER = "X-PT-Transfers-Artifact-Size";
const PROVENANCE_HEADER = "X-PT-Raptor-Bundle-Provenance";
const PROVENANCE_VALUE = "transfers-v1";

/**
 * Set transfer-artifact provenance headers on the reply. The provenance
 * marker is always written; the per-artifact fields are omitted when meta
 * is absent or incomplete so the frontend can distinguish "no transfers"
 * from "transfers present but stale".
 *
 * Must be called on BOTH the 304 and 200 branches so a transfer-only
 * change (same PTB ETag) still delivers a fresh hash without forcing a
 * multi-MB PTB redownload.
 */
function setTransfersArtifactHeaders(
  reply: FastifyReply,
  meta: TransfersArtifactMeta | null | undefined,
): void {
  reply.header(PROVENANCE_HEADER, PROVENANCE_VALUE);
  if (!meta?.url || !meta.hash || !Number.isFinite(meta.sizeBytes) || meta.sizeBytes < 0) return;
  reply
    .header(TRANSFERS_URL_HEADER, meta.url)
    .header(TRANSFERS_HASH_HEADER, meta.hash)
    .header(TRANSFERS_SIZE_HEADER, String(meta.sizeBytes));
}

export interface RaptorBundleOptions {
  /**
   * Per-response observability hook — called once per request with the
   * final HTTP status and (for 200s) the response encoding. Optional;
   * default no-op. Production wiring lives in src/index.ts and routes
   * to the prom-client counter `pt_raptor_bundle_requests_total`.
   */
  onRequest?: (status: number, encoding?: "gzip" | "identity") => void;
  /**
   * Fastify route-level rate-limit config. Production wiring passes
   * `rateLimitForRoute("raptorBundle")`. Tests omit it to skip
   * per-request limit accounting.
   */
  rateLimit?: { max: number; timeWindow: string };
  /**
   * Returns the current transfers artifact metadata (URL, hash, byte
   * count) to be reflected as provenance response headers. Called once
   * per request — callers must NOT cache the returned value across
   * requests, as the transfer bundle can reload independently of the PTB.
   * Returns null/undefined when no transfers artifact is loaded.
   */
  getTransfersArtifactMeta?: () => TransfersArtifactMeta | null | undefined;
}

function clientAcceptsGzip(acceptEncoding: string | undefined): boolean {
  return acceptEncoding != null && /\bgzip\b/i.test(acceptEncoding);
}

/**
 * Build the cache slot + handler closure. Each `registerRaptorBundleRoute`
 * call gets a fresh cache, so tests instantiating a new Fastify per
 * `beforeEach` are naturally isolated — no test-only reset export needed.
 */
function createBundleLoader(): {
  loadAndCache: (path: string) => Promise<CachedBundle | null>;
  prewarm: (path: string) => Promise<void>;
} {
  let cached: CachedBundle | null = null;
  // Path-keyed in-flight map so concurrent cold requests for the same path
  // share a single hash+gzip; concurrent requests for DIFFERENT paths each
  // get their own compute. Never two paths' work conflated.
  const inFlight = new Map<string, Promise<CachedBundle | null>>();

  async function compute(path: string): Promise<CachedBundle | null> {
    const st = statSync(path);
    if (st.size === 0) return null;
    if (
      cached &&
      cached.path === path &&
      cached.mtimeMs === st.mtimeMs &&
      cached.size === st.size
    ) {
      return cached;
    }
    const raw = readFileSync(path);
    const contentEtag = `"${createHash("sha256").update(raw).digest("hex").slice(0, 32)}"`;
    const gz = await gzipAsync(raw, { level: 6 });
    cached = { path, mtimeMs: st.mtimeMs, size: st.size, contentEtag, raw, gz };
    return cached;
  }

  async function loadAndCache(path: string): Promise<CachedBundle | null> {
    const existing = inFlight.get(path);
    if (existing) return existing;
    const p = compute(path).finally(() => {
      inFlight.delete(path);
    });
    inFlight.set(path, p);
    return p;
  }

  async function prewarm(path: string): Promise<void> {
    try {
      await loadAndCache(path);
    } catch {
      // Swallow — the per-request handler will surface the failure on the
      // first user request. Warmup is best-effort.
    }
  }

  return { loadAndCache, prewarm };
}

export function registerRaptorBundleRoute(
  app: FastifyInstance,
  options: RaptorBundleOptions = {},
): { prewarm: (path: string) => Promise<void> } {
  const { loadAndCache, prewarm } = createBundleLoader();
  const onRequest = options.onRequest ?? (() => {});
  const getTransfersArtifactMeta = options.getTransfersArtifactMeta ?? (() => null);

  async function handler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const path = process.env.PT_BUNDLE_PATH;
    if (!path || !existsSync(path)) {
      request.log.warn(
        { code: "PTB_BUNDLE_UNAVAILABLE", path: path ?? null },
        "raptor-bundle 503: PT_BUNDLE_PATH unset or file missing",
      );
      onRequest(503);
      return void reply.code(503).send({
        error: {
          code: "PTB_BUNDLE_UNAVAILABLE",
          message:
            "PTB bundle not available on this backend. wasm engine requires PTB-sidecar boot.",
        },
      });
    }

    let bundle: CachedBundle | null;
    try {
      bundle = await loadAndCache(path);
    } catch (err) {
      // statSync/readFileSync can throw on EACCES, EISDIR, or a TOCTOU race
      // where the sidecar (de)materialises the file between existsSync and
      // statSync. Surface as 503 so the documented "bundle unavailable"
      // contract holds; the wasm frontend's caller treats 503 as the same
      // class of failure regardless of root cause.
      request.log.warn(
        { code: "PTB_BUNDLE_UNREADABLE", path, err: (err as Error).message },
        "raptor-bundle 503: read failed",
      );
      onRequest(503);
      return void reply.code(503).send({
        error: {
          code: "PTB_BUNDLE_UNREADABLE",
          message: `PTB bundle read failed: ${(err as Error).message}`,
        },
      });
    }
    if (!bundle) {
      request.log.warn(
        { code: "PTB_BUNDLE_EMPTY", path },
        "raptor-bundle 503: file is empty",
      );
      onRequest(503);
      return void reply.code(503).send({
        error: { code: "PTB_BUNDLE_EMPTY", message: "PTB file is empty" },
      });
    }

    const transfersArtifactMeta = getTransfersArtifactMeta();

    const ifNoneMatch = request.headers["if-none-match"];
    if (ifNoneMatch === bundle.contentEtag) {
      onRequest(304);
      setTransfersArtifactHeaders(reply, transfersArtifactMeta);
      return void reply
        .header("Vary", "Accept-Encoding")
        .header("ETag", bundle.contentEtag)
        .header("Cache-Control", "public, max-age=0, must-revalidate")
        .code(304)
        .send();
    }

    setTransfersArtifactHeaders(reply, transfersArtifactMeta);
    reply
      .header("Content-Type", "application/octet-stream")
      .header("ETag", bundle.contentEtag)
      // max-age=0 + must-revalidate: lets intermediates store the body so
      // revalidation only costs an ETag round-trip, but forces the check
      // every request — the sidecar can atomic-rename the PTB at any time,
      // and a stale CDN copy alongside a fresh /api/schedule-tile produces
      // inconsistent client state.
      .header("Cache-Control", "public, max-age=0, must-revalidate")
      .header("Vary", "Accept-Encoding");

    const acceptEncoding = request.headers["accept-encoding"] as
      | string
      | undefined;
    if (clientAcceptsGzip(acceptEncoding)) {
      onRequest(200, "gzip");
      reply.header("Content-Encoding", "gzip").send(bundle.gz);
    } else {
      onRequest(200, "identity");
      reply.send(bundle.raw);
    }
  }

  const routeConfig = options.rateLimit
    ? { config: { rateLimit: options.rateLimit } }
    : {};
  // Fastify auto-derives HEAD from GET by default (exposeHeadRoutes: true),
  // so the HEAD test in raptorBundle.test.ts works without an explicit
  // registration. The handler doesn't stream — it calls reply.send(Buffer)
  // — which is the shape Fastify can short-circuit to headers-only.
  app.get("/api/raptor-bundle", routeConfig, handler);

  return { prewarm };
}
