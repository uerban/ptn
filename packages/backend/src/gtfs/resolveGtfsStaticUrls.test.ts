import { describe, it, expect } from "vitest";
import { resolveGtfsStaticUrls } from "./resolveGtfsStaticUrls.js";

describe("resolveGtfsStaticUrls", () => {
  it("defaults to vilnius when GTFS_STATIC_URL is empty and NOT in PTB mode", () => {
    expect(resolveGtfsStaticUrls(undefined, false)).toEqual(["https://stops.lt/vilnius/vilnius/gtfs.zip"]);
    expect(resolveGtfsStaticUrls("", false)).toEqual(["https://stops.lt/vilnius/vilnius/gtfs.zip"]);
    expect(resolveGtfsStaticUrls("   ", false)).toEqual(["https://stops.lt/vilnius/vilnius/gtfs.zip"]);
  });
  it("returns EMPTY (no vilnius default) when empty AND in PTB mode — so an unconfigured fallback fails closed", () => {
    expect(resolveGtfsStaticUrls(undefined, true)).toEqual([]);
    expect(resolveGtfsStaticUrls("", true)).toEqual([]);
  });
  it("uses + dedups + trims explicit URLs regardless of PTB mode", () => {
    expect(resolveGtfsStaticUrls("https://a.zip, https://b.zip , https://a.zip", true)).toEqual(["https://a.zip", "https://b.zip"]);
    expect(resolveGtfsStaticUrls("https://a.zip", false)).toEqual(["https://a.zip"]);
  });
});
