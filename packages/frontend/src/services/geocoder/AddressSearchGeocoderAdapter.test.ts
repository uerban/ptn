import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { db, type AddressSearchArtifactRecord } from "../../db/index.ts";
import {
  AddressSearchGeocoderAdapter,
  __clearAddressSearchAdapterCacheForTests,
  localAddressCandidates,
} from "./AddressSearchGeocoderAdapter.ts";

// The index itself is Rust: `pt_geocode` owns normalization, the query-variant
// expansion and the FST scan, and its behaviour is tested there and through the
// pt-wasm binding. What this suite owns is the adapter's half — that a cached
// record is discovered, that hits become GeocoderCandidates with the right
// provider/tier, that scoring and ordering are applied, and that the wasm index
// is built once per corpus. So the wasm boundary is mocked, not the search.
const searchSpy = vi.fn();
const buildSpy = vi.fn();
vi.mock("../addressIndexWasm.ts", () => ({
  buildAddressIndex: (bytes: ArrayBuffer) => {
    buildSpy(bytes);
    return Promise.resolve({
      search: (query: string, limit: number) => searchSpy(query, limit),
      rowCount: () => 2,
      keyCount: () => 4,
      fstSizeBytes: () => 1024,
      cityId: () => "vilnius",
      free: () => {},
    });
  },
}));

const KUDIRKA_HIT = {
  label: "V. Kudirkos aikštė 1",
  lat: 54.6872,
  lon: 25.2797,
  rowId: 0,
  matchedKey: "kudirk aikste",
  exact: true,
};

function addressRecord(): AddressSearchArtifactRecord {
  return {
    cityId: "vilnius",
    sha256: "a".repeat(64),
    sizeBytes: 512,
    generatedAt: "2026-08-15T00:00:00.000Z",
    installedAt: Date.now(),
    rowCount: 2,
    keyCount: 4,
    bytes: new ArrayBuffer(512),
  };
}

describe("AddressSearchGeocoderAdapter", () => {
  beforeEach(async () => {
    __clearAddressSearchAdapterCacheForTests();
    await db.addressSearchArtifacts.clear();
    searchSpy.mockReset();
    buildSpy.mockReset();
    searchSpy.mockReturnValue([KUDIRKA_HIT]);
  });

  it("is available only when the active city has a cached artifact", async () => {
    const adapter = new AddressSearchGeocoderAdapter(() => "vilnius");
    await expect(adapter.isAvailable()).resolves.toBe(false);

    await db.addressSearchArtifacts.put(addressRecord());

    await expect(adapter.isAvailable()).resolves.toBe(true);
  });

  it("passes the raw query through and maps hits to local candidates", async () => {
    // The raw text goes to wasm untouched: normalization and the variant
    // expansion (synonyms, stemming, the Slavic term-first rotation) belong to
    // pt_geocode, so the adapter must not pre-chew the query.
    await db.addressSearchArtifacts.put(addressRecord());

    const results = await localAddressCandidates(
      "vilnius",
      "площадь Кудирки",
      null,
      new AbortController().signal,
    );

    expect(searchSpy).toHaveBeenCalledWith("площадь Кудирки", 10);
    expect(results[0]).toMatchObject({
      label: "V. Kudirkos aikštė 1",
      provider: "address-bundle",
      privacyTier: "local",
      rowId: 0,
      matchedKey: "kudirk aikste",
    });
  });

  it("scores an exact variant match above a mere prefix match", async () => {
    await db.addressSearchArtifacts.put(addressRecord());
    searchSpy.mockReturnValue([
      { ...KUDIRKA_HIT, label: "B prefix", rowId: 1, exact: false },
      KUDIRKA_HIT,
    ]);

    const results = await localAddressCandidates(
      "vilnius",
      "kudirk",
      null,
      new AbortController().signal,
    );

    expect(results.map((r) => r.label)).toEqual(["V. Kudirkos aikštė 1", "B prefix"]);
    expect(results[0]!.confidence).toBeGreaterThan(results[1]!.confidence);
  });

  it("builds the wasm index once per corpus, not once per query", async () => {
    // The index cache is keyed on the corpus sha256, so repeated queries
    // against the same packed corpus must not rebuild it.
    await db.addressSearchArtifacts.put(addressRecord());
    const signal = new AbortController().signal;

    await localAddressCandidates("vilnius", "kudirk", null, signal);
    await localAddressCandidates("vilnius", "gedimino", null, signal);

    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when the corpus sha changes", async () => {
    await db.addressSearchArtifacts.put(addressRecord());
    const signal = new AbortController().signal;
    await localAddressCandidates("vilnius", "kudirk", null, signal);

    await db.addressSearchArtifacts.put({ ...addressRecord(), sha256: "b".repeat(64) });
    await localAddressCandidates("vilnius", "kudirk", null, signal);

    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it("forward returns local geocoder candidates and reverse is unsupported", async () => {
    await db.addressSearchArtifacts.put(addressRecord());
    const adapter = new AddressSearchGeocoderAdapter(() => "vilnius");

    const forward = await adapter.forward(
      "Kudirk",
      null,
      new AbortController().signal,
    );
    const reverse = await adapter.reverse(
      { lat: 54.6872, lon: 25.2797 },
      new AbortController().signal,
    );

    expect(forward[0]).toMatchObject({
      label: "V. Kudirkos aikštė 1",
      provider: "address-bundle",
      privacyTier: "local",
    });
    expect(reverse).toBeNull();
  });
});
