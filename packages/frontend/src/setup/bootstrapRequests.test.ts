import { describe, expect, it } from "vitest";
import { isAllowedBeforeSetup } from "./bootstrapRequests.ts";

const origin = "https://ptn.example";
const allowed = (url: string) => isAllowedBeforeSetup(url, origin);

describe("requests allowed before setup", () => {
  it("allows the app shell, the city catalog and the chosen city's manifest", () => {
    for (const url of [
      "/",
      "/index.html",
      "/assets/index-B2qAAsLg.js",
      "/assets/en-B2ItfdFG.js",
      "/assets/privacy-DnirjiGt.js",
      "/deployment-config.js",
      "/sw.js",
      "/favicon.svg",
      "/api/cities",
      "/api/vilnius/gtfs/manifest",
    ]) {
      expect(allowed(url), url).toBe(true);
    }
  });

  it("refuses optional operator endpoints", () => {
    for (const url of [
      "/api/vilnius/alerts",
      "/api/vilnius/gtfs/rt-tile/1/2",
      "/api/vilnius/rt/route-1",
      "/api/vilnius/departures-for-stop?stopId=1",
      "/api/vilnius/stops/nearby?lat=1&lon=2",
      "/api/vilnius/version",
      "/api/vilnius/gtfs/schedule-tile/1",
      "/geocoder-config.json",
      "/poi/manifest.json",
      "/micromap/vilnius.micromap.br",
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it("refuses map-only assets and every other origin", () => {
    expect(allowed("/assets/vendor-map-BkggAV4a.js")).toBe(false);
    expect(allowed("/assets/maplibre-gl-worker-Cx9.js")).toBe(false);
    expect(allowed("/node_modules/.vite/deps/maplibre-gl.js")).toBe(false);
    expect(allowed("/glyphs/Open%20Sans%20Regular/0-255.pbf")).toBe(false);
    expect(allowed("https://basemaps.cartocdn.com/gl/positron.json")).toBe(false);
    expect(allowed("https://other.example/api/cities")).toBe(false);
  });
});
