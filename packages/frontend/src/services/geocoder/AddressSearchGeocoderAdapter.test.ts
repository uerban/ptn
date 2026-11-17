import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import type {PtAddressIndexHandle} from "../addressIndexWasm.ts";
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
const buildSpy = vi.fn<(bytes: ArrayBuffer) => Promise<PtAddressIndexHandle>>();
vi.mock("../addressIndexWasm.ts", () => ({
  buildAddressIndex: (bytes: ArrayBuffer) => buildSpy(bytes),
}));
function indexHandle(search = (query: string, limit: number) => searchSpy(query, limit)): PtAddressIndexHandle {
  return {search, rowCount: () => 2, keyCount: () => 4, fstSizeBytes: () => 1024,
    cityId: () => "vilnius", free: () => {}};
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {resolve = ok; reject = fail;});
  return {promise, resolve, reject};
}

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
    buildSpy.mockReset().mockImplementation(async () => indexHandle());
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

  it("preserves native exact-house preference when candidate confidence ties", async () => {
    await db.addressSearchArtifacts.put(addressRecord());
    // Token fallback can match an exact house number without the matched key
    // equalling the full query variant. Both wire exact flags stay false.
    searchSpy.mockReturnValue([
      {...KUDIRKA_HIT, label:"Central Square 1", matchedKey:"central square 1", exact:false},
      {...KUDIRKA_HIT, label:"Central Avenue 100", rowId:1, matchedKey:"central avenue 100", exact:false},
    ]);
    const results = await localAddressCandidates("vilnius", "centr 1", null, new AbortController().signal);
    expect(results.map(r=>r.label)).toEqual(["Central Square 1", "Central Avenue 100"]);
    expect(results[0]!.confidence).toBe(results[1]!.confidence);
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

  it("shares a pending index build across concurrent queries for one corpus", async () => {
    await db.addressSearchArtifacts.put(addressRecord());
    const pending = deferred<PtAddressIndexHandle>();
    buildSpy.mockReturnValue(pending.promise);
    const signal = new AbortController().signal;
    const a = localAddressCandidates("vilnius", "kudirk", null, signal);
    const b = localAddressCandidates("vilnius", "gedimino", null, signal);
    await vi.waitFor(() => expect(buildSpy).toHaveBeenCalled());
    pending.resolve(indexHandle());
    await Promise.all([a,b]);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls.map(call=>call[0]).sort()).toEqual(["gedimino","kudirk"]);
  });

  it("does not let a late old corpus build replace the newer cached index", async () => {
    await db.addressSearchArtifacts.put(addressRecord());
    const pending = deferred<PtAddressIndexHandle>();
    const oldIndex = indexHandle(() => [{...KUDIRKA_HIT,label:"Old corpus"}]);
    const newIndex = indexHandle(() => [{...KUDIRKA_HIT,label:"New corpus"}]);
    buildSpy.mockReturnValueOnce(pending.promise).mockResolvedValue(newIndex);
    const signal = new AbortController().signal;
    const old = localAddressCandidates("vilnius", "kudirk", null, signal);
    await vi.waitFor(() => expect(buildSpy).toHaveBeenCalledTimes(1));
    await db.addressSearchArtifacts.put({...addressRecord(),sha256:"b".repeat(64)});
    expect((await localAddressCandidates("vilnius", "kudirk", null, signal))[0]!.label).toBe("New corpus");
    pending.resolve(oldIndex);
    expect((await old)[0]!.label).toBe("Old corpus");
    expect((await localAddressCandidates("vilnius", "kudirk", null, signal))[0]!.label).toBe("New corpus");
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it("shares build failure and retries instead of caching a rejected promise", async () => {
    await db.addressSearchArtifacts.put(addressRecord());
    const pending = deferred<PtAddressIndexHandle>();
    buildSpy.mockReturnValueOnce(pending.promise).mockReturnValueOnce(pending.promise);
    const signal = new AbortController().signal;
    const settled = Promise.allSettled([
      localAddressCandidates("vilnius", "kudirk", null, signal),
      localAddressCandidates("vilnius", "gedimino", null, signal),
    ]);
    await vi.waitFor(() => expect(buildSpy).toHaveBeenCalled());
    pending.reject(new Error("index unavailable"));
    expect((await settled).map(result=>result.status)).toEqual(["rejected","rejected"]);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    buildSpy.mockReset().mockResolvedValue(indexHandle());
    expect(await localAddressCandidates("vilnius", "kudirk", null, signal)).toHaveLength(1);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it("does not evict a newer successful corpus when an older build fails", async () => {
    await db.addressSearchArtifacts.put(addressRecord());
    const pending = deferred<PtAddressIndexHandle>();
    buildSpy.mockReturnValueOnce(pending.promise).mockResolvedValue(indexHandle());
    const signal = new AbortController().signal;
    const old = localAddressCandidates("vilnius", "kudirk", null, signal).catch(error=>error);
    await vi.waitFor(() => expect(buildSpy).toHaveBeenCalledTimes(1));
    await db.addressSearchArtifacts.put({...addressRecord(),sha256:"b".repeat(64)});
    await localAddressCandidates("vilnius", "kudirk", null, signal);
    pending.reject(new Error("old build failed"));
    expect(await old).toBeInstanceOf(Error);
    await localAddressCandidates("vilnius", "kudirk", null, signal);
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps a shared index build usable when one waiting query aborts", async () => {
    await db.addressSearchArtifacts.put(addressRecord());
    const pending = deferred<PtAddressIndexHandle>();
    buildSpy.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const a = localAddressCandidates("vilnius", "kudirk", null, controller.signal).catch(error=>error);
    const b = localAddressCandidates("vilnius", "gedimino", null, new AbortController().signal);
    await vi.waitFor(() => expect(buildSpy).toHaveBeenCalled());
    controller.abort();pending.resolve(indexHandle());
    expect(await a).toMatchObject({name:"AbortError"});
    expect(await b).toHaveLength(1);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps city cache entries independent even when artifact hashes match", async () => {
    await db.addressSearchArtifacts.bulkPut([addressRecord(), {...addressRecord(),cityId:"gdansk"}]);
    const signal = new AbortController().signal;
    await Promise.all([
      localAddressCandidates("vilnius", "kudirk", null, signal),
      localAddressCandidates("gdansk", "kudirk", null, signal),
    ]);
    await localAddressCandidates("vilnius", "gedimino", null, signal);
    await localAddressCandidates("gdansk", "gedimino", null, signal);
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(searchSpy).toHaveBeenCalledTimes(4);
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
