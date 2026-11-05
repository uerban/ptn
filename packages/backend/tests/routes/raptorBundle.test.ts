import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerRaptorBundleRoute,
  type RaptorBundleOptions,
} from "../../src/routes/raptorBundle.js";

describe("GET /api/raptor-bundle", () => {
  let tmpDir: string;
  let bundlePath: string;

  beforeEach(() => {
    // Each test instantiates a fresh Fastify + route registration, which
    // builds a fresh closure-scoped cache — no test-only reset export
    // needed.
    tmpDir = mkdtempSync(join(tmpdir(), "raptor-bundle-test-"));
    bundlePath = join(tmpDir, "test.ptb");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PT_BUNDLE_PATH;
    vi.restoreAllMocks();
  });

  /**
   * Helper: build a Fastify app with a non-empty PTB file and optional
   * RaptorBundleOptions overrides, then return the app (caller must close).
   */
  async function buildAppWithRaptorBundle(
    opts: Pick<RaptorBundleOptions, "getTransfersArtifactMeta"> = {},
  ) {
    const bytes = Buffer.from([0x50, 0x54, 0x42, 0x00, 1, 2, 3, 4]);
    writeFileSync(bundlePath, bytes);
    process.env.PT_BUNDLE_PATH = bundlePath;
    const app = Fastify();
    registerRaptorBundleRoute(app, opts);
    return app;
  }

  it("returns 503 when PT_BUNDLE_PATH is unset", async () => {
    delete process.env.PT_BUNDLE_PATH;
    const app = Fastify();
    registerRaptorBundleRoute(app);
    const res = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("PTB_BUNDLE_UNAVAILABLE");
    await app.close();
  });

  it("returns 503 when PTB file is empty (panel qa HIGH — corrupt body would 200 silently)", async () => {
    writeFileSync(bundlePath, Buffer.alloc(0));
    process.env.PT_BUNDLE_PATH = bundlePath;
    const app = Fastify();
    registerRaptorBundleRoute(app);
    const res = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns gzipped bytes with Vary + ETag when Accept-Encoding includes gzip", async () => {
    const bytes = Buffer.from([0x50, 0x54, 0x42, 0x00, 0x04, 0, 0, 0, 1, 2, 3, 4]);
    writeFileSync(bundlePath, bytes);
    process.env.PT_BUNDLE_PATH = bundlePath;
    const app = Fastify();
    registerRaptorBundleRoute(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/raptor-bundle",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(res.headers["etag"]).toBeDefined();
    expect(Buffer.compare(gunzipSync(res.rawPayload), bytes)).toBe(0);
    await app.close();
  });

  it("returns raw bytes when Accept-Encoding omits gzip", async () => {
    const bytes = Buffer.from([0x50, 0x54, 0x42, 0x00, 1]);
    writeFileSync(bundlePath, bytes);
    process.env.PT_BUNDLE_PATH = bundlePath;
    const app = Fastify();
    registerRaptorBundleRoute(app);
    const res = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(Buffer.compare(res.rawPayload, bytes)).toBe(0);
    await app.close();
  });

  it("returns 304 on If-None-Match matching current ETag", async () => {
    const bytes = Buffer.from([0x50, 0x54, 0x42, 0x00]);
    writeFileSync(bundlePath, bytes);
    process.env.PT_BUNDLE_PATH = bundlePath;
    const app = Fastify();
    registerRaptorBundleRoute(app);
    const first = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    const etag = first.headers["etag"] as string;
    const second = await app.inject({
      method: "GET",
      url: "/api/raptor-bundle",
      headers: { "if-none-match": etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.rawPayload.length).toBe(0);
    expect(second.headers["vary"]).toBe("Accept-Encoding");
    await app.close();
  });

  it("ETag changes when content changes even if mtime+size are identical (panel qa HIGH — mtime collision)", async () => {
    const a = Buffer.from([1, 2, 3, 4]);
    const b = Buffer.from([5, 6, 7, 8]);
    writeFileSync(bundlePath, a);
    const fixed = new Date(2026, 4, 23, 12, 0, 0);
    utimesSync(bundlePath, fixed, fixed);
    process.env.PT_BUNDLE_PATH = bundlePath;
    const appA = Fastify();
    registerRaptorBundleRoute(appA);
    const first = await appA.inject({ method: "GET", url: "/api/raptor-bundle" });
    await appA.close();
    writeFileSync(bundlePath, b);
    utimesSync(bundlePath, fixed, fixed);
    // Fresh app/route → fresh closure cache; equivalent to invalidating the
    // single in-process slot. mtime+size are identical to the first write.
    const appB = Fastify();
    registerRaptorBundleRoute(appB);
    const second = await appB.inject({ method: "GET", url: "/api/raptor-bundle" });
    expect(second.headers["etag"]).not.toBe(first.headers["etag"]);
    await appB.close();
  });

  it("returns 503 PTB_BUNDLE_UNREADABLE when statSync throws (e.g. EACCES, TOCTOU race)", async () => {
    // Simulate the unhappy read path: PT_BUNDLE_PATH points at a directory,
    // so existsSync passes but statSync()-then-readFileSync()-via-loadAndCache
    // throws EISDIR. Pre-fix this crashed the handler and surfaced as 500;
    // post-fix it surfaces as 503 with the documented contract.
    process.env.PT_BUNDLE_PATH = tmpDir; // a directory, not a file
    const app = Fastify();
    registerRaptorBundleRoute(app);
    const res = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("PTB_BUNDLE_UNREADABLE");
    await app.close();
  });

  it("cache key includes path; two different paths with same mtime+size don't alias", async () => {
    const a = join(tmpDir, "a.ptb");
    const b = join(tmpDir, "b.ptb");
    writeFileSync(a, Buffer.from([1, 2]));
    writeFileSync(b, Buffer.from([3, 4]));
    const fixed = new Date(2026, 4, 23, 12, 0, 0);
    utimesSync(a, fixed, fixed);
    utimesSync(b, fixed, fixed);

    const app = Fastify();
    registerRaptorBundleRoute(app);

    process.env.PT_BUNDLE_PATH = a;
    const ra = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    process.env.PT_BUNDLE_PATH = b;
    const rb = await app.inject({ method: "GET", url: "/api/raptor-bundle" });

    expect(rb.headers["etag"]).not.toBe(ra.headers["etag"]);
    expect(Buffer.compare(rb.rawPayload, Buffer.from([3, 4]))).toBe(0);
    await app.close();
  });

  it("serves from cache without re-reading the file on warm requests (perf #4 pin)", async () => {
    // Pins the "cached after first read" contract documented on
    // raptorBundle.ts. A refactor that regressed into per-request
    // readFileSync would silently 10x the latency budget under load.
    // Detection: after the first GET warms the cache, replace the file's
    // contents while preserving mtime+size. The cache key is (path,
    // mtime, size); a cache HIT returns the original etag/body, a MISS
    // would observe the new bytes via readFileSync and emit a different
    // etag.
    const original = Buffer.from([0x50, 0x54, 0x42, 0x00, 1, 2, 3, 4, 5, 6]);
    const tampered = Buffer.from([0x50, 0x54, 0x42, 0x00, 9, 9, 9, 9, 9, 9]);
    expect(original.length).toBe(tampered.length); // same size, by construction
    writeFileSync(bundlePath, original);
    const fixed = new Date(2026, 4, 23, 12, 0, 0);
    utimesSync(bundlePath, fixed, fixed);
    process.env.PT_BUNDLE_PATH = bundlePath;
    const app = Fastify();
    registerRaptorBundleRoute(app);
    const r1 = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    expect(r1.statusCode).toBe(200);
    // Mutate file in place, preserving mtime+size. A handler that re-reads
    // per request would surface `tampered` on the next call; the cache
    // contract requires it to keep returning `original`.
    writeFileSync(bundlePath, tampered);
    utimesSync(bundlePath, fixed, fixed);
    const r2 = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    const r3 = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    expect(r2.headers["etag"]).toBe(r1.headers["etag"]);
    expect(r3.headers["etag"]).toBe(r1.headers["etag"]);
    expect(Buffer.compare(r2.rawPayload, original)).toBe(0);
    expect(Buffer.compare(r3.rawPayload, original)).toBe(0);
    await app.close();
  });

  it("HEAD returns the same headers as GET with no body", async () => {
    // CDNs/HTTP-cache layers use HEAD for revalidation; if it 404'd the
    // wasm caller's preflight would silently fall back. Fastify wires HEAD
    // explicitly in registerRaptorBundleRoute.
    const bytes = Buffer.from([0x50, 0x54, 0x42, 0x00, 9, 8, 7, 6]);
    writeFileSync(bundlePath, bytes);
    process.env.PT_BUNDLE_PATH = bundlePath;
    const app = Fastify();
    registerRaptorBundleRoute(app);
    const head = await app.inject({ method: "HEAD", url: "/api/raptor-bundle" });
    const get = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    expect(head.statusCode).toBe(200);
    expect(head.headers["etag"]).toBe(get.headers["etag"]);
    expect(head.headers["content-type"]).toBe("application/octet-stream");
    expect(head.rawPayload.length).toBe(0);
    await app.close();
  });

  it("includes transfer provenance headers on a gzip 200 response", async () => {
    const app = await buildAppWithRaptorBundle({
      getTransfersArtifactMeta: () => ({
        url: "/api/vilnius/transfers/fetch",
        hash: "abc123",
        sizeBytes: 42,
      }),
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/raptor-bundle",
      headers: { "accept-encoding": "gzip" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-pt-raptor-bundle-provenance"]).toBe("transfers-v1");
    expect(res.headers["x-pt-transfers-artifact-url"]).toBe("/api/vilnius/transfers/fetch");
    expect(res.headers["x-pt-transfers-artifact-hash"]).toBe("abc123");
    expect(res.headers["x-pt-transfers-artifact-size"]).toBe("42");
    await app.close();
  });

  it("includes transfer provenance headers on an identity 200 response", async () => {
    const app = await buildAppWithRaptorBundle({
      getTransfersArtifactMeta: () => ({
        url: "/api/vilnius/transfers/fetch",
        hash: "abc123",
        sizeBytes: 42,
      }),
    });

    // No accept-encoding → identity body (not gzip); headers must still be present.
    const res = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["x-pt-raptor-bundle-provenance"]).toBe("transfers-v1");
    expect(res.headers["x-pt-transfers-artifact-url"]).toBe("/api/vilnius/transfers/fetch");
    expect(res.headers["x-pt-transfers-artifact-hash"]).toBe("abc123");
    expect(res.headers["x-pt-transfers-artifact-size"]).toBe("42");
    await app.close();
  });

  it("includes transfer provenance headers on a derived HEAD response", async () => {
    const app = await buildAppWithRaptorBundle({
      getTransfersArtifactMeta: () => ({
        url: "/api/vilnius/transfers/fetch",
        hash: "abc123",
        sizeBytes: 42,
      }),
    });

    // Fastify derives HEAD from the GET handler, so provenance headers ride along.
    const head = await app.inject({ method: "HEAD", url: "/api/raptor-bundle" });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.length).toBe(0);
    expect(head.headers["x-pt-raptor-bundle-provenance"]).toBe("transfers-v1");
    expect(head.headers["x-pt-transfers-artifact-hash"]).toBe("abc123");
    expect(head.headers["x-pt-transfers-artifact-size"]).toBe("42");
    await app.close();
  });

  it("includes fresh transfer provenance headers on 304 when PTB ETag is unchanged", async () => {
    let hash = "oldhash";
    const app = await buildAppWithRaptorBundle({
      getTransfersArtifactMeta: () => ({
        url: "/api/vilnius/transfers/fetch",
        hash,
        sizeBytes: 42,
      }),
    });

    const first = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag;

    hash = "newhash";
    const second = await app.inject({
      method: "GET",
      url: "/api/raptor-bundle",
      headers: { "if-none-match": String(etag) },
    });

    expect(second.statusCode).toBe(304);
    expect(second.headers["x-pt-raptor-bundle-provenance"]).toBe("transfers-v1");
    expect(second.headers["x-pt-transfers-artifact-hash"]).toBe("newhash");
    await app.close();
  });

  it("omits transfer provenance headers when metadata is absent", async () => {
    const app = await buildAppWithRaptorBundle({ getTransfersArtifactMeta: () => null });
    const res = await app.inject({ method: "GET", url: "/api/raptor-bundle" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-pt-raptor-bundle-provenance"]).toBe("transfers-v1");
    expect(res.headers["x-pt-transfers-artifact-url"]).toBeUndefined();
    expect(res.headers["x-pt-transfers-artifact-hash"]).toBeUndefined();
    expect(res.headers["x-pt-transfers-artifact-size"]).toBeUndefined();
    await app.close();
  });
});
