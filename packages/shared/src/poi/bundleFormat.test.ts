import { describe, it, expectTypeOf } from "vitest";
import type { PoiBundle, PoiBundleMeta, PoiEntry, Tier } from "./bundleFormat.js";

describe("bundleFormat types", () => {
  it("Tier is strict | loose", () => {
    expectTypeOf<Tier>().toEqualTypeOf<"strict" | "loose">();
  });

  it("PoiEntry.source is curated | osm", () => {
    expectTypeOf<PoiEntry["source"]>().toEqualTypeOf<"curated" | "osm">();
  });

  it("PoiBundleMeta.attribution is a string literal", () => {
    expectTypeOf<PoiBundleMeta["attribution"]>().toEqualTypeOf<"\u00a9 OpenStreetMap contributors">();
  });

  it("PoiBundleMeta.licenseUrl is a string literal", () => {
    expectTypeOf<PoiBundleMeta["licenseUrl"]>().toEqualTypeOf<"https://opendatacommons.org/licenses/odbl/">();
  });

  it("PoiBundle.entries is PoiEntry[]", () => {
    expectTypeOf<PoiBundle["entries"]>().toEqualTypeOf<PoiEntry[]>();
  });

  it("PoiEntry has expected required fields", () => {
    expectTypeOf<PoiEntry>().toHaveProperty("id");
    expectTypeOf<PoiEntry>().toHaveProperty("name");
    expectTypeOf<PoiEntry>().toHaveProperty("aliases");
    expectTypeOf<PoiEntry>().toHaveProperty("category");
    expectTypeOf<PoiEntry>().toHaveProperty("lat");
    expectTypeOf<PoiEntry>().toHaveProperty("lon");
    expectTypeOf<PoiEntry>().toHaveProperty("source");
    expectTypeOf<PoiEntry>().toHaveProperty("rankBoost");
    expectTypeOf<PoiEntry>().toHaveProperty("tier");
  });

  it("PoiEntry has optional fields", () => {
    expectTypeOf<PoiEntry["wikidataId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PoiEntry["osmId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PoiEntry["nearestStopGroupId"]>().toEqualTypeOf<string | null | undefined>();
  });

  it("a valid bundle object satisfies the interface", () => {
    const bundle: PoiBundle = {
      meta: {
        cityId: "gdansk",
        version: "abc123",
        attribution: "\u00a9 OpenStreetMap contributors",
        licenseUrl: "https://opendatacommons.org/licenses/odbl/",
        sourcePbfTimestamp: "2026-04-13T00:00:00Z",
        bundleGeneratedAt: "2026-04-14T00:00:00Z",
        tier: "strict",
        entryCount: 1,
      },
      entries: [
        {
          id: "test-1",
          name: "Test POI",
          aliases: { en: ["Test"] },
          category: "landmark",
          lat: 54.35,
          lon: 18.65,
          source: "curated",
          rankBoost: 1.0,
          tier: "strict",
        },
      ],
    };
    expectTypeOf(bundle).toMatchTypeOf<PoiBundle>();
  });
});
