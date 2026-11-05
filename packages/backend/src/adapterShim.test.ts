import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { buildShim, registryForCity } from "./adapterShim.js";
import { adapterRegistryFor, createAdapterRegistry } from "./adapters/registry.js";

/**
 * Two stops, deliberately in the WRONG order for vilnius: the far-away one
 * first. Both are inside no other fixture city's bbox, so any reordering that
 * happens can only come from the bbox the shim resolved for this request.
 */
const GEOCODE_TWO_STOPS = [
  { type: "STOP", id: "far", name: "Elsewhere", lat: 10.0, lon: 10.0 },
  { type: "STOP", id: "local", name: "Stotis", lat: 54.6719, lon: 25.2834 },
];

// A fresh Response per call: a body can only be read once, so a single shared
// mockResolvedValue makes the SECOND request fail with "Body has already been
// read" — which looks exactly like an adapter fault (502) rather than a test bug.
function stubGeocode() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify(GEOCODE_TWO_STOPS), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("adapter shim — per-request city resolution", () => {
  let app: Awaited<ReturnType<typeof buildShim>>;

  beforeEach(async () => {
    app = await buildShim();
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("resolves the bbox from the path slug, so one process orders results per city", async () => {
    stubGeocode();

    const vilnius = await app.inject({ url: "/api/vilnius/stops/search?q=stotis" });
    const paris = await app.inject({ url: "/api/paris/stops/search?q=stotis" });

    expect(vilnius.statusCode).toBe(200);
    expect(paris.statusCode).toBe(200);

    // Same upstream bytes for both. The only difference is which bbox the shim
    // picked, so this is the whole singleton premise under test: the vilnius
    // stop is promoted for vilnius and left where upstream put it for paris.
    expect(JSON.parse(vilnius.body).data.map((s: { id: string }) => s.id)).toEqual(["local", "far"]);
    expect(JSON.parse(paris.body).data.map((s: { id: string }) => s.id)).toEqual(["far", "local"]);
  });

  it("404s an unknown city rather than silently serving without a bbox", async () => {
    stubGeocode();
    const res = await app.inject({ url: "/api/atlantis/stops/search?q=stotis" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("UNKNOWN_CITY");
    // The upstream must not have been consulted — a 404 that still burns a
    // third-party request would defeat the point of validating first.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("recognises Tbilisi and promotes its local stops", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify([
        GEOCODE_TWO_STOPS[0],
        { type: "STOP", id: "tbilisi-local", name: "თავისუფლების მოედანი", lat: 41.694, lon: 44.801 },
      ]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await app.inject({ url: "/api/tbilisi/stops/search?q=metro" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.map((s: { id: string }) => s.id)).toEqual(["tbilisi-local", "far"]);
  });

  it("serves nearby and alerts under the same city-scoped shape", async () => {
    stubGeocode();
    const nearby = await app.inject({ url: "/api/tricity/nearby?lat=54.35&lon=18.65" });
    expect(nearby.statusCode).toBe(200);

    // `/alerts` is the one route with no query contract at all.
    const alerts = await app.inject({ url: "/api/oslo/alerts" });
    expect(alerts.statusCode).toBe(200);
  });

  it("keeps the city segment in the route label — this is the plane discriminator", async () => {
    stubGeocode();
    const res = await app.inject({ url: "/api/vilnius/stops/search?q=stotis" });
    expect(res.statusCode).toBe(200);
    // A per-city backend registers `/api/stops/search` (nginx strips the slug
    // before proxying). If this ever collapses to that spelling, the
    // `route` label on http_request_duration_seconds stops telling the two
    // planes apart and the shim becomes unattributable in a scrape.
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).toContain("/api/:city/stops/search");
    expect(routes).not.toContain("/api/stops/search");
  });

  it("memoises one registry per city and does not rebuild it per request", () => {
    expect(registryForCity("vilnius")).toBe(registryForCity("vilnius"));
    expect(registryForCity("vilnius")).not.toBe(registryForCity("paris"));
    expect(registryForCity("atlantis")).toBeNull();
  });

  it("resolves the slug case-insensitively, like getCityProfile", () => {
    expect(registryForCity("VILNIUS")).toBe(registryForCity("vilnius"));
  });
});

describe("adapterRegistryFor — the seam shared with the per-city backends", () => {
  it("prefers the request-scoped registry when one is set", async () => {
    const perRequest = createAdapterRegistry();
    const app = Fastify();
    const serverScoped = createAdapterRegistry();
    app.decorate("adapters", serverScoped);
    app.decorateRequest("adapters", null);

    let seen: unknown = null;
    app.get("/shim", async (request) => {
      (request as unknown as { adapters: unknown }).adapters = perRequest;
      seen = adapterRegistryFor(request);
      return { ok: true };
    });
    // No request decorator assigned — the per-city backends' path.
    let seenServer: unknown = null;
    app.get("/percity", async (request) => {
      seenServer = adapterRegistryFor(request);
      return { ok: true };
    });
    await app.ready();

    await app.inject({ url: "/shim" });
    await app.inject({ url: "/percity" });
    await app.close();

    expect(seen).toBe(perRequest);
    // The fallback is NOT dead code while backend-<city> containers exist.
    expect(seenServer).toBe(serverScoped);
  });
});
