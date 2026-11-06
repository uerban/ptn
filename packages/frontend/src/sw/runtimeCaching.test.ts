import { describe, it, expect } from "vitest";
import { runtimeCaching } from "./runtimeCaching.js";

/** Returns the first rule in the ordered array whose urlPattern matches url,
 *  or undefined if none match. */
function firstMatch(url: string) {
  return runtimeCaching.find((rule) => rule.urlPattern.test(url));
}

/** Returns the index of the first matching rule, or -1 if none. */
function firstMatchIndex(url: string) {
  return runtimeCaching.findIndex((rule) => rule.urlPattern.test(url));
}

const gtfsNetworkOnly = runtimeCaching.find(
  (r) =>
    r.urlPattern.source.includes("gtfs") && r.handler === "NetworkOnly",
);

const apiCatchAll = runtimeCaching.find(
  (r) => r.urlPattern.source === "\\/api\\/" && r.handler === "NetworkFirst",
);

const healthNetworkOnly = runtimeCaching.find(
  (r) =>
    r.urlPattern.source.includes("health") && r.handler === "NetworkOnly",
);

const addressSearchNetworkOnly = runtimeCaching.find(
  (r) =>
    r.urlPattern.source.includes("address-search") && r.handler === "NetworkOnly",
);

/** Workbox's `CacheableResponse.isResponseCacheable` (workbox 7): the status
 *  must be listed, then any listed header must match exactly. */
function cacheable(url: string, status: number, contentType: string): boolean {
  const config = firstMatch(url)?.options?.cacheableResponse;
  if (!config) return true;
  if (config.statuses && !config.statuses.includes(status)) return false;
  if (!config.headers) return true;
  const headers = new Headers({ "Content-Type": contentType });
  return Object.entries(config.headers).some(
    ([name, value]) => headers.get(name) === value,
  );
}

describe("binary artifacts are cached only as binary 200s", () => {
  for (const url of [
    "https://ptn.example/micromap/vilnius.micromap.br",
  ]) {
    it(`keeps a 200 application/octet-stream for ${url}`, () => {
      expect(cacheable(url, 200, "application/octet-stream")).toBe(true);
    });

    it(`refuses an HTML page, an opaque or an error response for ${url}`, () => {
      expect(cacheable(url, 200, "text/html")).toBe(false);
      expect(cacheable(url, 0, "application/octet-stream")).toBe(false);
      expect(cacheable(url, 404, "application/octet-stream")).toBe(false);
    });
  }
});

describe("micromap artifacts", () => {
  it("serves the offline micromap CacheFirst so a reload works with no network", () => {
    const rule = firstMatch("https://ptn.example/micromap/vilnius.micromap.br");
    expect(rule?.handler).toBe("CacheFirst");
    expect(rule?.options?.cacheName).toBe("micromap-artifacts");
  });

  it("does not swallow other static assets", () => {
    expect(firstMatch("https://ptn.example/poi/vilnius.br")).toBeUndefined();
  });
});

describe("managed OSM artifacts", () => {
  it("never serves stale discovery or unvalidated graph bytes from a SW cache", () => {
    for (const path of ["/osm/current/oslo.json", "/osm/releases/" + "a".repeat(64) + "/manifest.json",
      "/osm/releases/" + "a".repeat(64) + "/walk-graph.ptwg.br"]) {
      expect(firstMatch(path)?.handler).toBe("NetworkOnly");
    }
  });
  it("does not intercept unrelated paths", () => {
    expect(firstMatch("/osm/private/source.pbf")).toBeUndefined();
  });
});

describe("runtimeCaching exports an ordered array", () => {
  it("exports a non-empty array", () => {
    expect(Array.isArray(runtimeCaching)).toBe(true);
    expect(runtimeCaching.length).toBeGreaterThan(0);
  });
});

describe("gtfs NetworkOnly rule exists", () => {
  it("has a NetworkOnly rule whose pattern includes gtfs", () => {
    expect(gtfsNetworkOnly).toBeDefined();
    expect(gtfsNetworkOnly!.handler).toBe("NetworkOnly");
  });
});

// A liveness probe replayed from cache reports the state of the network at
// cache-write time, not now — the "backend down" banner stayed hidden for a
// full hour of a real outage because the /api/ catch-all had cached a 200.
describe("health probes are never served from cache", () => {
  it("routes /api/<city>/health/ready to a NetworkOnly rule", () => {
    expect(firstMatch("/api/vilnius/health/ready")).toBe(healthNetworkOnly);
  });

  it("routes the other health probes the same way", () => {
    expect(firstMatch("/api/vilnius/health/live")).toBe(healthNetworkOnly);
    expect(firstMatch("/api/vilnius/health/rt")).toBe(healthNetworkOnly);
    expect(firstMatch("/api/vilnius/health")).toBe(healthNetworkOnly);
  });

  it("appears before the /api/ catch-all", () => {
    expect(firstMatchIndex("/api/vilnius/health/ready")).toBeLessThan(
      runtimeCaching.indexOf(apiCatchAll!),
    );
  });

  it("does not steal sibling API routes", () => {
    expect(firstMatch("/api/vilnius/stops/all")).not.toBe(healthNetworkOnly);
    expect(firstMatch("/api/vilnius/healthy-stops")).not.toBe(healthNetworkOnly);
  });
});

describe("address-search NetworkOnly rule", () => {
  it("matches /api/<city>/address-search query requests", () => {
    expect(firstMatch("/api/vilnius/address-search?q=Kudirkos")).toBe(
      addressSearchNetworkOnly,
    );
  });

  it("matches the manifest and bundle endpoints", () => {
    expect(firstMatch("/api/vilnius/address-search/manifest")).toBe(
      addressSearchNetworkOnly,
    );
    expect(firstMatch("/api/vilnius/address-search/bundle")).toBe(
      addressSearchNetworkOnly,
    );
  });
});

describe("gtfs NetworkOnly rule — positive matches", () => {
  it("matches /api/paris/gtfs/manifest", () => {
    const match = firstMatch("/api/paris/gtfs/manifest");
    expect(match).toBe(gtfsNetworkOnly);
  });

  it("matches /api/paris/gtfs/schedule-tile/<hash>/6km/<coords>", () => {
    const match = firstMatch(
      "/api/paris/gtfs/schedule-tile/abc123def456/6km/48.8566_2.3522",
    );
    expect(match).toBe(gtfsNetworkOnly);
  });

  it("matches /api/paris/gtfs/rt-tile/<hash>/6km/<coords>", () => {
    const match = firstMatch(
      "/api/paris/gtfs/rt-tile/abc123def456/6km/48.8566_2.3522",
    );
    expect(match).toBe(gtfsNetworkOnly);
  });

  it("matches generation-qualified /api/gtfs/poi-tile requests", () => {
    const match = firstMatch(
      `/api/gtfs/poi-tile/gdansk/12km/0_0?v=${"a".repeat(64)}`,
    );
    expect(match).toBe(gtfsNetworkOnly);
  });

  it("matches POI tiles behind an optional API city slug", () => {
    const match = firstMatch(
      `/api/paris/gtfs/poi-tile/gdansk/12km/0_0?v=${"a".repeat(64)}`,
    );
    expect(match).toBe(gtfsNetworkOnly);
  });

  it("matches without city slug — /gtfs/manifest relative path style", () => {
    // The optional city slug group (?:[^/]+\/)? allows matching without it
    const match = firstMatch("/api/gtfs/manifest");
    expect(match).toBe(gtfsNetworkOnly);
  });
});

describe("gtfs NetworkOnly rule — negative: does NOT match these URLs", () => {
  it("does NOT match /api/paris/departures", () => {
    expect(firstMatch("/api/paris/departures")).not.toBe(gtfsNetworkOnly);
  });

  it("does NOT match /api/paris/stops/all", () => {
    expect(firstMatch("/api/paris/stops/all")).not.toBe(gtfsNetworkOnly);
  });

  it("does NOT match /api/paris/version", () => {
    expect(firstMatch("/api/paris/version")).not.toBe(gtfsNetworkOnly);
  });

  it("does NOT match /api/paris/gtfs/shapes/shapes-x.json", () => {
    expect(firstMatch("/api/paris/gtfs/shapes/shapes-x.json")).not.toBe(
      gtfsNetworkOnly,
    );
  });
});

describe("rule ordering", () => {
  it("gtfs NetworkOnly rule appears before the /api/ catch-all", () => {
    const gtfsIdx = runtimeCaching.indexOf(gtfsNetworkOnly!);
    const catchAllIdx = runtimeCaching.indexOf(apiCatchAll!);
    expect(gtfsIdx).toBeGreaterThanOrEqual(0);
    expect(catchAllIdx).toBeGreaterThanOrEqual(0);
    expect(gtfsIdx).toBeLessThan(catchAllIdx);
  });

  it("address-search NetworkOnly rule appears before the /api/ catch-all", () => {
    const addressIdx = runtimeCaching.indexOf(addressSearchNetworkOnly!);
    const catchAllIdx = runtimeCaching.indexOf(apiCatchAll!);
    expect(addressIdx).toBeGreaterThanOrEqual(0);
    expect(catchAllIdx).toBeGreaterThanOrEqual(0);
    expect(addressIdx).toBeLessThan(catchAllIdx);
  });

  it("gtfs NetworkOnly rule appears AFTER the /version rule", () => {
    const versionRule = runtimeCaching.find((r) =>
      r.urlPattern.source.includes("version"),
    );
    const gtfsIdx = runtimeCaching.indexOf(gtfsNetworkOnly!);
    const versionIdx = runtimeCaching.indexOf(versionRule!);
    expect(versionIdx).toBeGreaterThanOrEqual(0);
    expect(gtfsIdx).toBeGreaterThan(versionIdx);
  });

  it("gtfs NetworkOnly rule appears AFTER the /departures rule", () => {
    const departuresRule = runtimeCaching.find((r) =>
      r.urlPattern.source.includes("departures"),
    );
    const gtfsIdx = runtimeCaching.indexOf(gtfsNetworkOnly!);
    const departuresIdx = runtimeCaching.indexOf(departuresRule!);
    expect(departuresIdx).toBeGreaterThanOrEqual(0);
    expect(gtfsIdx).toBeGreaterThan(departuresIdx);
  });

  it("gtfs NetworkOnly rule appears AFTER the /stops/ rule", () => {
    const stopsRule = runtimeCaching.find((r) =>
      r.urlPattern.source.includes("stops"),
    );
    const gtfsIdx = runtimeCaching.indexOf(gtfsNetworkOnly!);
    const stopsIdx = runtimeCaching.indexOf(stopsRule!);
    expect(stopsIdx).toBeGreaterThanOrEqual(0);
    expect(gtfsIdx).toBeGreaterThan(stopsIdx);
  });

  it("/api/paris/departures is NOT matched by the gtfs rule (matched by departures rule instead)", () => {
    const match = firstMatch("/api/paris/departures");
    expect(match).not.toBe(gtfsNetworkOnly);
    // It should match the departures NetworkFirst rule or the catch-all — not the gtfs rule
    expect(match?.handler).toBe("NetworkFirst");
  });

  it("/api/paris/departures-for-stop lands on the DEPARTURES rule, not the catch-all", () => {
    // The client moved off the legacy `/departures` route onto pt-serve's
    // `departures-for-stop` (retirement plan step 4). The pattern is a prefix
    // match so no rule change was needed — but "no change needed" is a claim
    // worth pinning: falling through to the /api/ catch-all instead would swap
    // a 3 s network timeout and 5 min TTL for 5 s and 1 h, silently serving
    // hour-old departures to an offline rider.
    const departuresRule = runtimeCaching.find((r) =>
      r.urlPattern.source.includes("departures"),
    );
    expect(firstMatch("/api/paris/departures-for-stop")).toBe(departuresRule);
  });

  it("/api/paris/stops/all is NOT matched by the gtfs rule (matched by stops rule instead)", () => {
    const match = firstMatch("/api/paris/stops/all");
    expect(match).not.toBe(gtfsNetworkOnly);
    expect(match?.handler).toBe("NetworkFirst");
  });

  it("/api/paris/version is NOT matched by the gtfs rule (matched by version rule instead)", () => {
    const match = firstMatch("/api/paris/version");
    expect(match).not.toBe(gtfsNetworkOnly);
    expect(match?.handler).toBe("NetworkOnly");
    // And it must not be the gtfs rule
    expect(match?.urlPattern.source).not.toContain("gtfs");
  });

  it("firstMatchIndex for gtfs manifest < firstMatchIndex for api catch-all", () => {
    const gtfsIdx = firstMatchIndex("/api/paris/gtfs/manifest");
    const catchAllIdx = runtimeCaching.indexOf(apiCatchAll!);
    expect(gtfsIdx).toBeGreaterThanOrEqual(0);
    expect(gtfsIdx).toBeLessThan(catchAllIdx);
  });
});

it("leaves catalog, readiness and routing bundle freshness to their verified loaders", () => {
  for (const path of ["/api/cities", "/api/custom/ready", "/api/custom/raptor-bundle"]) {
    expect(firstMatch(path)?.handler).toBe("NetworkOnly");
  }
});
