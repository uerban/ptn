import { describe, expect, it } from "vitest";
import { BASEMAP_PROVIDERS, getBasemapProvider } from "./basemapProviders.ts";

describe("basemap providers", () => {
  it("registers CARTO against the detailed-basemap flow", () => {
    const carto = BASEMAP_PROVIDERS.carto;
    expect(carto.flowId).toBe("external.detailed-basemap");
    expect(carto.requestFields).toEqual(["tileCoordinates"]);
    expect(carto.lightStyleUrl).toMatch(/^https:\/\/basemaps\.cartocdn\.com\//);
    expect(carto.darkStyleUrl).toMatch(/^https:\/\/basemaps\.cartocdn\.com\//);
    expect(Object.isFrozen(carto.requestFields)).toBe(true);
  });

  it("fails closed for an unknown provider", () => {
    expect(getBasemapProvider("unknown")).toBeUndefined();
  });
});
