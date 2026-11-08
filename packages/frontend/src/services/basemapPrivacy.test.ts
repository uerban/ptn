import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DETAILED_BASEMAP_FLOW,
  fetchBasemapStyle,
  getDetailedBasemapStatus,
  guardMapRequest,
  isExternalBasemapAllowed,
  reportDetailedBasemapStatus,
} from "./basemapPrivacy.ts";
import { allowFlow, denyFlow, resetFlows } from "../test-helpers/networkDecisions.ts";

const controller = new AbortController();
const style = { version: 8, sources: {}, layers: [] };

function styleResponse(): Response {
  return new Response(JSON.stringify(style), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("basemap network gate", () => {
  beforeEach(() => resetFlows());

  it("allows a registered provider only once its decision is allowed", () => {
    expect(isExternalBasemapAllowed("carto")).toBe(false);
    allowFlow(DETAILED_BASEMAP_FLOW, "carto");
    expect(isExternalBasemapAllowed("carto")).toBe(true);
    expect(isExternalBasemapAllowed()).toBe(true);
    denyFlow(DETAILED_BASEMAP_FLOW, "carto");
    expect(isExternalBasemapAllowed("carto")).toBe(false);
  });

  it("never allows an unknown provider", () => {
    allowFlow(DETAILED_BASEMAP_FLOW, "unknown");
    expect(isExternalBasemapAllowed("unknown")).toBe(false);
  });

  it("does not fetch while unset or when the provider is unknown", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchBasemapStyle({ providerId: "carto", dark: false, signal: controller.signal, fetchImpl }),
    ).resolves.toBeNull();
    await expect(
      fetchBasemapStyle({
        providerId: "unknown",
        dark: false,
        signal: controller.signal,
        isAllowed: () => true,
        fetchImpl,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drops a fetched style when the decision is revoked before it applies", async () => {
    allowFlow(DETAILED_BASEMAP_FLOW, "carto");
    const fetchImpl = vi.fn().mockImplementation(async () => {
      denyFlow(DETAILED_BASEMAP_FLOW, "carto");
      return styleResponse();
    });

    await expect(
      fetchBasemapStyle({ providerId: "carto", dark: false, signal: controller.signal, fetchImpl }),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fetches the registered theme URL once the provider is allowed", async () => {
    allowFlow(DETAILED_BASEMAP_FLOW, "carto");
    const fetchImpl = vi.fn().mockResolvedValue(styleResponse());

    await expect(
      fetchBasemapStyle({ providerId: "carto", dark: true, signal: controller.signal, fetchImpl }),
    ).resolves.toEqual(style);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/dark-matter/);
  });
});

describe("map request guard", () => {
  const origin = "https://ptn.example";

  beforeEach(() => resetFlows());

  it("lets same-origin and inline requests through untouched", () => {
    expect(guardMapRequest(`${origin}/tiles/1/2/3.pbf`, "Tile", origin)).toBeUndefined();
    expect(guardMapRequest("/glyphs/x/0-255.pbf", "Glyphs", origin)).toBeUndefined();
    expect(guardMapRequest("data:application/json,{}", "SpriteJSON", origin)).toBeUndefined();
  });

  it("answers provider tiles, glyphs and sprites locally until the provider is allowed", () => {
    const tile = "https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/1/2/3.mvt";
    expect(guardMapRequest(tile, "Tile", origin)).toMatch(/^data:application\/x-protobuf/);
    expect(
      guardMapRequest("https://a.basemaps.cartocdn.com/light_all/1/2/3.png", "Tile", origin),
    ).toMatch(/^data:image\/png/);
    expect(
      guardMapRequest("https://tiles.basemaps.cartocdn.com/fonts/a/0-255.pbf", "Glyphs", origin),
    ).toMatch(/^data:application\/x-protobuf/);
    expect(
      guardMapRequest("https://tiles.basemaps.cartocdn.com/gl/positron/sprite.json", "SpriteJSON", origin),
    ).toMatch(/^data:application\/json/);
    expect(
      guardMapRequest("https://tiles.basemaps.cartocdn.com/gl/positron/sprite.png", "SpriteImage", origin),
    ).toMatch(/^data:image\/png/);

    allowFlow(DETAILED_BASEMAP_FLOW, "carto");
    expect(guardMapRequest(tile, "Tile", origin)).toBeUndefined();

    // Revoked: the next request is local again.
    denyFlow(DETAILED_BASEMAP_FLOW, "carto");
    expect(guardMapRequest(tile, "Tile", origin)).toMatch(/^data:/);
  });

  it("never lets an unregistered host through, even with a provider allowed", () => {
    allowFlow(DETAILED_BASEMAP_FLOW, "carto");
    expect(
      guardMapRequest("https://tile.openstreetmap.org/1/2/3.png", "Tile", origin),
    ).toMatch(/^data:/);
    expect(
      guardMapRequest("https://basemaps.cartocdn.com.evil.example/x.pbf", "Tile", origin),
    ).toMatch(/^data:/);
  });
});

describe("detailed basemap status", () => {
  it("tracks the latest reported status", () => {
    reportDetailedBasemapStatus("off");
    expect(getDetailedBasemapStatus()).toBe("off");
    reportDetailedBasemapStatus("loading");
    expect(getDetailedBasemapStatus()).toBe("loading");
    reportDetailedBasemapStatus("failed");
    expect(getDetailedBasemapStatus()).toBe("failed");
    reportDetailedBasemapStatus("off");
  });
});
