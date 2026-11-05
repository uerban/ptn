import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ADDRESS_SEARCH_ARTIFACT_SCHEMA_VERSION,
  ADDRESS_SEARCH_EXTRACT_SCHEMA_VERSION,
  type AddressSearchArtifact,
  type AddressSearchKey,
  type AddressSearchRow,
} from "./artifact.js";

describe("address search artifact contract", () => {
  it("uses a pinned schema version", () => {
    // The SHIPPED artifact is the packed binary one (magic PTAS). Bumping this
    // is a wire-format change: pt-serve advertises it in the manifest and the
    // PWA refuses a manifest that does not match.
    expect(ADDRESS_SEARCH_ARTIFACT_SCHEMA_VERSION).toBe(1);
    // The extractor's JSON intermediate is a separate contract that happens to
    // sit at the same number — it is never served and never committed, only fed
    // to `pt-producer pack-address-search`. The two move independently.
    expect(ADDRESS_SEARCH_EXTRACT_SCHEMA_VERSION).toBe(1);
    expectTypeOf<typeof ADDRESS_SEARCH_ARTIFACT_SCHEMA_VERSION>().toEqualTypeOf<1>();
    expectTypeOf<typeof ADDRESS_SEARCH_EXTRACT_SCHEMA_VERSION>().toEqualTypeOf<1>();
  });

  it("keeps display rows separate from normalized lookup keys", () => {
    expectTypeOf<AddressSearchRow>().toHaveProperty("label");
    expectTypeOf<AddressSearchKey>().toHaveProperty("key");
    expectTypeOf<AddressSearchKey["rowId"]>().toEqualTypeOf<number>();
  });

  it("a valid artifact object satisfies the interface", () => {
    // AddressSearchArtifact is the EXTRACTOR's shape, so it carries the
    // extract version, not the shipped one.
    const artifact: AddressSearchArtifact = {
      schemaVersion: ADDRESS_SEARCH_EXTRACT_SCHEMA_VERSION,
      cityId: "vilnius",
      source: "fixture.osm.pbf",
      generatedAt: "2026-08-15T00:00:00.000Z",
      rows: [{ label: "V. Kudirkos aikštė 1", lat: 54.6872, lon: 25.2797 }],
      keys: [{ key: "kudirk aikste 1", rowId: 0 }],
      stats: {
        rawFeatureCount: 1,
        rowCount: 1,
        keyCount: 1,
        skippedNoStreet: 0,
      },
    };

    expectTypeOf(artifact).toMatchTypeOf<AddressSearchArtifact>();
  });
});
