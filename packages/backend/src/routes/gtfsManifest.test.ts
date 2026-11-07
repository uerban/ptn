import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { ManifestSnapshot } from "../gtfs/scheduler.js";
import { createGtfsManifestHandler } from "./gtfsManifest.js";

describe("gtfsManifest route", () => {
  function mkApp(snapshot: ManifestSnapshot | null, lastKnownHash: string | null = null, realtimeHeader?: string) {
    const app = Fastify({ logger: false });
    app.get("/api/gtfs/manifest", createGtfsManifestHandler({
      getManifestSnapshot: () => snapshot,
      getLastKnownBundleHash: () => lastKnownHash,
      realtimeHeader,
    }));
    return app;
  }

  it("200 body == snapshot.parsed, ETag from contentEtag", async () => {
    const snap: ManifestSnapshot = {
      bundleHash: "abc",
      subdivisions: {},
      contentEtag: "deadbeef".repeat(4).slice(0, 32),
      parsed: { schemaVersion: 1, bundleHash: "abc", generatedAt: 1, tileSize: 6000, subdivisions: {} } as any,
    };
    const res = await mkApp(snap).inject({ method: "GET", url: "/api/gtfs/manifest" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(snap.parsed);
    expect(res.headers["etag"]).toBe('"' + snap.contentEtag + '"');
    expect(res.headers["x-pt-bundle-hash"]).toBe("abc");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("304 when If-None-Match matches", async () => {
    const snap: ManifestSnapshot = {
      bundleHash: "abc",
      subdivisions: {},
      contentEtag: "deadbeef".repeat(4).slice(0, 32),
      parsed: { schemaVersion: 1, bundleHash: "abc", generatedAt: 1, tileSize: 6000, subdivisions: {} } as any,
    };
    const app = mkApp(snap);
    const first = await app.inject({ method: "GET", url: "/api/gtfs/manifest" });
    const etag = first.headers["etag"]!;
    const second = await app.inject({ method: "GET", url: "/api/gtfs/manifest", headers: { "if-none-match": etag } });
    expect(second.statusCode).toBe(304);
  });

  it("503 MANIFEST_UNAVAILABLE on cold start", async () => {
    const res = await mkApp(null).inject({ method: "GET", url: "/api/gtfs/manifest" });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload).error.code).toBe("MANIFEST_UNAVAILABLE");
    expect(res.headers["x-pt-bundle-hash"]).toBeUndefined();
  });

  it("503 + X-PT-Bundle-Hash via getLastKnownBundleHash", async () => {
    const res = await mkApp(null, "abc").inject({ method: "GET", url: "/api/gtfs/manifest" });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload).error.code).toBe("MANIFEST_UNAVAILABLE");
    expect(res.headers["x-pt-bundle-hash"]).toBe("abc");
  });

  describe("X-PT-Realtime", () => {
    const snap: ManifestSnapshot = {
      bundleHash: "abc",
      subdivisions: {},
      contentEtag: "deadbeef".repeat(4).slice(0, 32),
      parsed: { schemaVersion: 1, bundleHash: "abc", generatedAt: 1, tileSize: 6000, subdivisions: {} } as any,
    };

    for (const value of ["departures", ""]) {
      it(`sent on 200 and 304 (${JSON.stringify(value)}); body and ETag unchanged`, async () => {
        const plain = await mkApp(snap).inject({ method: "GET", url: "/api/gtfs/manifest" });
        const app = mkApp(snap, null, value);
        const ok = await app.inject({ method: "GET", url: "/api/gtfs/manifest" });
        expect(ok.statusCode).toBe(200);
        expect(ok.headers["x-pt-realtime"]).toBe(value);
        expect(ok.payload).toBe(plain.payload);
        expect(ok.headers["etag"]).toBe(plain.headers["etag"]);

        const notModified = await app.inject({
          method: "GET",
          url: "/api/gtfs/manifest",
          headers: { "if-none-match": ok.headers["etag"] as string },
        });
        expect(notModified.statusCode).toBe(304);
        expect(notModified.headers["x-pt-realtime"]).toBe(value);
        expect(notModified.headers["etag"]).toBe(plain.headers["etag"]);
      });
    }

    it("absent when not configured, and never on the 503", async () => {
      const plain = await mkApp(snap).inject({ method: "GET", url: "/api/gtfs/manifest" });
      expect(plain.headers["x-pt-realtime"]).toBeUndefined();
      const cold = await mkApp(null, null, "departures").inject({ method: "GET", url: "/api/gtfs/manifest" });
      expect(cold.statusCode).toBe(503);
      expect(cold.headers["x-pt-realtime"]).toBeUndefined();
    });
  });
});
