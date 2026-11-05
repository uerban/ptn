import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerShapesRoute } from "../../src/routes/shapes.js";
import { registerCityGuard } from "../../src/plugins/cityGuard.js";
import { makeStoreWithShapes } from "../harness/mocks.js";

describe("GET /api/gtfs/shapes/:artifact", () => {
  it("serves the artifact body when hash matches; 404 otherwise", async () => {
    const app = Fastify();
    const store = makeStoreWithShapes([
      { shapeId: "A", encodedPolyline: "??", source: "gtfs" as const },
    ]);
    // @ts-expect-error attach for test
    app.decorate("gtfsStore", store);
    await registerShapesRoute(app);

    // Request the URL as it reaches the backend — after nginx / the vite dev
    // proxy have stripped the `/api/<city>/` prefix from the public URL
    // `/api/vilnius/gtfs/shapes/shapes-<hash>.json`.
    const hash = store.getShapesHash();
    const ok = await app.inject({
      method: "GET",
      url: `/api/gtfs/shapes/shapes-${hash}.json`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(ok.payload)).toEqual({
      shapes: [{ shapeId: "A", encodedPolyline: "??", source: "gtfs" }],
    });

    const missing = await app.inject({
      method: "GET",
      url: `/api/gtfs/shapes/shapes-deadbeef.json`,
    });
    expect(missing.statusCode).toBe(404);
  });

  /**
 * cross-city isolation.

 *
   * Each city in production runs its own backend container with its own
   * `gtfsStore`; nginx fans `/api/<city>/...` out to the matching upstream
   * and injects `X-PT-Expected-City: <city>` so a misconfigured upstream
   * is rejected at the wrong door (502, before any handler runs).
 *
   * This test simulates two backends with distinct stores and verifies:
   *   1. cityA's backend serves its own hash.
   *   2. A cityB-shaped hash on cityA's backend 404s — there is no
   *      cross-store fallback that could leak the wrong city's polyline
   *      data.
   *   3. A request with `X-PT-Expected-City: cityB` against cityA's
   *      backend is rejected 502 by `cityGuard` BEFORE the shapes
   *      handler runs — even when the URL hash would otherwise match.
 *
   * Removing any of those three guarantees should make the relevant
   * assertion fail; see the verify-fail trace in the bundle PR
   * description.
   */
  it("isolates per-city stores and respects the X-PT-Expected-City guard", async () => {
    async function makeCityApp(
      cityId: string,
      shapeId: string,
    ): Promise<{ app: FastifyInstance; hash: string }> {
      const app = Fastify({ logger: false });
      // CityGuard has to run BEFORE the route is registered, since it
      // installs an onRequest hook that rejects mismatches in
      // `addHook("onRequest", ...)` for the whole app.
      await registerCityGuard(app, { cityId });
      const store = makeStoreWithShapes([
        { shapeId, encodedPolyline: "??", source: "gtfs" as const },
      ]);
      // @ts-expect-error attach for test
      app.decorate("gtfsStore", store);
      await registerShapesRoute(app);
      return { app, hash: store.getShapesHash() };
    }

    const cityA = await makeCityApp("vilnius", "A");
    const cityB = await makeCityApp("paris", "B");

    try {
      // Sanity: shape ids "A" vs "B" produce distinct sha256s.
      expect(cityA.hash).not.toBe(cityB.hash);

      // (1) cityA serves its own hash.
      const ownOk = await cityA.app.inject({
        method: "GET",
        url: `/api/gtfs/shapes/shapes-${cityA.hash}.json`,
        headers: { "X-PT-Expected-City": "vilnius" },
      });
      expect(ownOk.statusCode).toBe(200);
      expect(JSON.parse(ownOk.payload)).toEqual({
        shapes: [{ shapeId: "A", encodedPolyline: "??", source: "gtfs" }],
      });

      // (2) cityB's hash on cityA's backend → 404. The store has no
      // cross-city fallback path, so the wrong hash never resolves.
      const crossStore = await cityA.app.inject({
        method: "GET",
        url: `/api/gtfs/shapes/shapes-${cityB.hash}.json`,
        headers: { "X-PT-Expected-City": "vilnius" },
      });
      expect(crossStore.statusCode).toBe(404);

      // (3) cityA's hash on cityA's backend, but the X-PT-Expected-City
      // header says cityB → 502 from cityGuard before the route handler
      // runs. Catches an nginx upstream misroute even when the URL hash
      // happens to match.
      const guardRejection = await cityA.app.inject({
        method: "GET",
        url: `/api/gtfs/shapes/shapes-${cityA.hash}.json`,
        headers: { "X-PT-Expected-City": "paris" },
      });
      expect(guardRejection.statusCode).toBe(502);
      const body = JSON.parse(guardRejection.payload) as Record<string, unknown>;
      expect(body.error).toBe("Backend misroute");
      expect(body.expected).toBe("paris");
      expect(body.actual).toBe("vilnius");
    } finally {
      await cityA.app.close();
      await cityB.app.close();
    }
  });
});
