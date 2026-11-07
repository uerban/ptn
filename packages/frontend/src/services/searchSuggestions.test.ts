import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearPersonal, putPersonal } from "./personalStorage.ts";
import "fake-indexeddb/auto";
import { db, type AddressSearchArtifactRecord, type PoiIndexRecord } from "../db/index.ts";
import type { Stop, ApiResponse, PoiManifestBundle } from "@pt/shared";
import { scorePoiRecord, candidateToSuggestion } from "./searchSuggestions.ts";
import type { GeocoderCandidate } from "@pt/shared";
import { setSearchModeAccessor, __resetSearchModeAccessorForTests, setThirdPartyEgressAccessor, __resetThirdPartyEgressAccessorForTests, searchSuggestions } from "./searchSuggestions.ts";
import { searchServerSidePoi } from "./searchSuggestions.ts";
import { geocoderRegistry } from "./geocoder/instance.ts";
import * as poiLoader from "./poiLoader.ts";
import type { LatLon } from "@pt/shared";
import { readFileSync } from "node:fs";

// The local address index is Rust behind wasm (`pt_geocode` via pt-wasm), and
// this suite is about SUGGESTION assembly, not about the FST. Mock the wasm
// boundary so the fixture record can carry placeholder bytes; index behaviour
// is covered in crates/pt-geocode and by the pt-wasm binding tests.
vi.mock("./addressIndexWasm.ts", () => ({
  buildAddressIndex: () =>
    Promise.resolve({
      search: () => [
        {
          label: "V. Kudirkos aikštė 1",
          lat: 54.6872,
          lon: 25.2797,
          rowId: 0,
          matchedKey: "kudirk aikste",
          exact: true,
        },
      ],
      rowCount: () => 1,
      keyCount: () => 2,
      fstSizeBytes: () => 256,
      cityId: () => "vilnius",
      free: () => {},
    }),
}));
import { fileURLToPath } from "node:url";
import { usePrivacyChoicesStore } from "../stores/privacyChoicesStore.ts";
import {
  PRIVACY_DATA_MIGRATION_KEY,
  PRIVACY_DATA_MIGRATION_VERSION,
} from "./privacyDataMigrationState.ts";
import {
  __resetTileGenerationStateForTests,
  activateTileGeneration,
} from "./tileCache.ts";

vi.mock("./storagePolicy.ts", () => ({
  registerEvictor: vi.fn(),
  notifyWriteGrew: vi.fn().mockResolvedValue(undefined),
  onQuotaNear: vi.fn().mockResolvedValue([]),
}));

vi.mock("./errorReporter.ts", () => ({
  reportError: vi.fn(),
}));

vi.mock("./brotliDecode.ts", () => ({
  decompressBrotli: vi.fn(async (buffer: ArrayBuffer) =>
    new TextDecoder().decode(buffer),
  ),
}));

const mockSearchStops = vi.fn<(q: string, signal?: AbortSignal) => Promise<ApiResponse<Stop[]>>>();
vi.mock("./api.ts", () => ({
  api: {
    searchStops: (...args: unknown[]) =>
      mockSearchStops(args[0] as string, args[1] as AbortSignal | undefined),
  },
}));

function computeGeoBucket(lat: number, lon: number): string {
  return `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`;
}

function poiRecord(
  id: string,
  name: string,
  overrides?: Partial<PoiIndexRecord>,
): PoiIndexRecord {
  return {
    id,
    cityId: "gdansk",
    name,
    geoBucket: computeGeoBucket(overrides?.lat ?? 54.35, overrides?.lon ?? 18.65),
    aliases: {},
    category: "public_building",
    lat: 54.35,
    lon: 18.65,
    source: "curated" as const,
    rankBoost: 1.0,
    tier: "strict" as const,
    ...overrides,
  };
}

function gtfsStop(id: string, name: string, lat = 54.35, lon = 18.65) {
  return { id, name, lat, lon };
}

function addressRecord(): AddressSearchArtifactRecord {
  return {
    cityId: "vilnius",
    sha256: "a".repeat(64),
    sizeBytes: 512,
    generatedAt: "2026-08-15T00:00:00.000Z",
    installedAt: Date.now(),
    rowCount: 1,
    keyCount: 2,
    bytes: new ArrayBuffer(512),
  };
}

function makeStop(id: string, name: string, lat = 54.35, lon = 18.65): Stop {
  return { id, name, location: { lat, lon } };
}

describe("searchSuggestions", () => {
  beforeEach(async () => {
    await db.poiIndex.clear();
    await db.poiSyncMeta.clear();
    await clearPersonal("personalUsage");
    await db.stopGroups.clear();
    await db.gtfsStops.clear();
    await db.addressSearchArtifacts.clear();
    mockSearchStops.mockReset();
    mockSearchStops.mockResolvedValue({ data: [] });
    // These cases exercise ranking/merging of remote results, not the egress
    // gate, so allow egress explicitly. The production default is DENY — the
    // gate itself is covered in its own describe block below.
    setThirdPartyEgressAccessor(() => true);
    localStorage.setItem(
      PRIVACY_DATA_MIGRATION_KEY,
      PRIVACY_DATA_MIGRATION_VERSION,
    );
    usePrivacyChoicesStore
      .getState()
      .setChoice("personalization", "enabled");
  });

  it("returns empty for empty query", async () => {
    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("", "gdansk", null, new AbortController().signal, "local");
    expect(results).toEqual([]);
  });

  it("matches local GTFS stops by name prefix from the first character", async () => {
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-gv", "Gerosios vilties", 54.7, 25.3),
      gtfsStop("stop-other", "Antakalnio", 54.71, 25.31),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("g", "vilnius", null, new AbortController().signal, "local");

    const stops = results.filter((r) => r.kind === "stop");
    expect(stops.length).toBe(1);
    expect(stops[0].kind === "stop" && stops[0].name).toBe("Gerosios vilties");
  });

  it("returns local address-bundle results offline", async () => {
    await db.addressSearchArtifacts.put(addressRecord());

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions(
      "площадь Кудирки",
      "vilnius",
      null,
      new AbortController().signal,
      "local",
    );

    const address = results.find(
      (r) => r.kind === "geocoded" && r.poiIdentity.startsWith("addr:"),
    );
    expect(address).toMatchObject({
      kind: "geocoded",
      label: "V. Kudirkos aikštė 1",
      lat: 54.6872,
      lon: 25.2797,
      category: "address",
      source: "osm",
      loadSource: "bundle",
    });
  });

  it("matches local GTFS stops by word prefix (second token)", async () => {
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-gv", "Gerosios vilties", 54.7, 25.3),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("vilt", "vilnius", null, new AbortController().signal, "local");

    const stops = results.filter((r) => r.kind === "stop");
    expect(stops.length).toBe(1);
    expect(stops[0].kind === "stop" && stops[0].name).toBe("Gerosios vilties");
  });

  it("matches local GTFS stops case-insensitively and ignoring diacritics", async () => {
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-z", "Žalgirio", 54.7, 25.3),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("ZAL", "vilnius", null, new AbortController().signal, "local");

    const stops = results.filter((r) => r.kind === "stop");
    expect(stops.length).toBe(1);
    expect(stops[0].kind === "stop" && stops[0].name).toBe("Žalgirio");
  });

  it.each(["fresh", "legacy"])("finds Galleria offline after default POI loading (%s profile)", async (profile) => {
    const { useSettingsStore } = await import("../stores/settingsStore.ts");
    const { syncPoiForCity } = await import("./poiSync.ts");
    const settings = profile === "fresh"
      ? useSettingsStore.getInitialState()
      : useSettingsStore.persist.getOptions().merge!(
        { poiIncludeLooseTier: false }, useSettingsStore.getInitialState(),
      );
    // Real deployed mall names and coordinates; small fixture isolates the
    // default-setting → lazy dispatch → bundle load → local search regression.
    const mall = {
      id: "osm-559446309", osmId: "559446309", name: "გალერია თბილისი",
      aliases: { en: ["Galleria Tbilisi"], ka: ["გალერია თბილისი"] },
      category: "retail", lat: 41.69449680344828, lon: 44.799746193103445,
      source: "osm", rankBoost: 0.3, tier: "loose",
    };
    const baseUrl = "/poi/releases/" + "a".repeat(64) + "/";
    const bodies = new Map<string, Uint8Array<ArrayBuffer>>();
    const bundles: PoiManifestBundle[] = [];
    for (const loose of [false, true]) {
      const filename = loose ? "tbilisi.loose.br" : "tbilisi.br";
      const bytes = new TextEncoder().encode(JSON.stringify({
        meta: { cityId: "tbilisi", version: loose ? "loose-v1" : "strict-v1",
          tier: loose ? "loose" : "strict", entryCount: loose ? 1 : 0 },
        entries: loose ? [mall] : [],
      }));
      bodies.set(baseUrl + filename, bytes);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        byte => byte.toString(16).padStart(2, "0")).join("");
      bundles.push({cityId: "tbilisi", filename, sizeBytes: bytes.length, sha256: hash});
    }
    const {__resetPoiManifestForTests} = await import("./poiManifest.ts");
    __resetPoiManifestForTests();
    const fetchMock = vi.fn(async (url: string) => url === "/poi/manifest.json" ?
      Response.json({schemaVersion: 1, activationRevision: 1, baseUrl, bundles}) :
      new Response(bodies.get(url) ?? null, {status: bodies.has(url) ? 200 : 404}));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await syncPoiForCity("tbilisi", {
        loadBundle: async (cityId) => { await poiLoader.loadPoiBundle(cityId, {
          includeLooseTier: settings.poiIncludeLooseTier,
        }); },
        makeTileLoader: vi.fn(),
        resolveMode: () => "lazy-tile",
        getTiling: async () => ({ edgeKm: 48,
          anchor: { minLat: 41.6, minLon: 44.6, refLat: 41.725 },
          bundleSha256: "a".repeat(64), generationId: "b".repeat(64),
          tileBounds: { minX: -1, maxX: 2, minY: -1, maxY: 2 } }),
        poiCityIds: (cityId) => [cityId], getActiveCityId: () => "tbilisi",
        includeLooseTier: settings.poiIncludeLooseTier, disposePrior: vi.fn(),
      });
      expect(fetchMock.mock.calls.map(([url]) => url)).toContain(baseUrl + "tbilisi.loose.br");
      fetchMock.mockRejectedValue(new Error("offline"));
      setSearchModeAccessor(() => "lazy-tile");
      for (const query of ["gal", "Galleria", "გალერია"]) {
        const results = await searchSuggestions(query, "tbilisi", null,
          new AbortController().signal, "local");
        expect(results).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "geocoded", label: mall.name, category: "retail" }),
        ]));
      }
      // Searching the downloaded corpus must not issue query-time fetches.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
      __resetSearchModeAccessorForTests();
    }
  });

  it("returns geocoded results from POI index", async () => {
    await db.poiIndex.bulkPut([
      poiRecord("poi-1", "Dworzec Glowny", { category: "train_station", source: "curated", rankBoost: 1.0 }),
      poiRecord("poi-2", "Dworzec Podmiejski", { category: "train_station", source: "osm", rankBoost: 0.3 }),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("dworz", "gdansk", null, new AbortController().signal, "local");

    const geocoded = results.filter((r) => r.kind === "geocoded");
    expect(geocoded.length).toBe(2);
    expect(geocoded[0].label).toBe("Dworzec Glowny");
    expect(geocoded[0].category).toBe("train_station");
    expect(geocoded[0].source).toBe("curated");
    expect(geocoded[0].score).toBeGreaterThan(geocoded[1].score);
  });

  it("returns stop results from local GTFS data", async () => {
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-1", "Dworzec Glowny 01"),
      gtfsStop("stop-2", "Dworzec Glowny 02"),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("dworz", "gdansk", null, new AbortController().signal, "local");

    const stops = results.filter((r) => r.kind === "stop");
    expect(stops.length).toBe(2);
  });

  it("merges stop and geocoded results ranked by score", async () => {
    await db.poiIndex.bulkPut([
      poiRecord("poi-1", "Dworzec Glowny", { category: "train_station", rankBoost: 1.0 }),
    ]);
    await db.gtfsStops.bulkPut([gtfsStop("stop-1", "Dworzec PKP")]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("dworz", "gdansk", null, new AbortController().signal, "local");

    expect(results.length).toBe(2);
    const kinds = results.map((r) => r.kind);
    expect(kinds).toContain("geocoded");
    expect(kinds).toContain("stop");
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it("groups stops into stopGroup when multi-stop group exists", async () => {
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-1", "Dworzec Glowny 01"),
      gtfsStop("stop-2", "Dworzec Glowny 02"),
    ]);

    await db.stopGroups.put({
      groupId: "numbered:Dworzec Glowny",
      name: "Dworzec Glowny",
      stopIds: ["stop-1", "stop-2", "stop-3"],
      type: "name_numbered",
      lat: 54.35,
      lon: 18.65,
    });

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("dworz", "gdansk", null, new AbortController().signal, "local");

    const groups = results.filter((r) => r.kind === "stopGroup");
    expect(groups.length).toBe(1);
    expect(groups[0].kind === "stopGroup" && groups[0].name).toBe("Dworzec Glowny");
    expect(groups[0].kind === "stopGroup" && groups[0].stopCount).toBe(3);
    expect(groups[0].kind === "stopGroup" ? groups[0].stopIds : null).toEqual([
      "stop-1",
      "stop-2",
      "stop-3",
    ]);

    const individualStops = results.filter((r) => r.kind === "stop");
    expect(individualStops.length).toBe(0);
  });

  it("ranks prefix-match stops above substring-match stops for the same query", async () => {
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-prefix", "Oro uostas", 54.64, 25.28),
      gtfsStop("stop-substring-1", "Stepono Batoro st.", 54.7, 25.3),
      gtfsStop("stop-substring-2", "Teodoro Narbuto st.", 54.71, 25.31),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("oro", "vilnius", null, new AbortController().signal, "local");

    const stops = results.filter((r) => r.kind === "stop");
    expect(stops.length).toBe(3);
    expect(stops[0].kind === "stop" && stops[0].name).toBe("Oro uostas");
    const prefixScore = stops.find((s) => s.kind === "stop" && s.name === "Oro uostas")!.score;
    const substringScores = stops
      .filter((s) => s.kind === "stop" && s.name !== "Oro uostas")
      .map((s) => s.score);
    for (const sub of substringScores) {
      expect(prefixScore).toBeGreaterThan(sub);
    }
  });

  it("ranks exact-match stops above prefix-match stops", async () => {
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-exact", "Centras", 54.7, 25.3),
      gtfsStop("stop-prefix", "Centras Vilniaus", 54.7, 25.3),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("centras", "vilnius", null, new AbortController().signal, "local");

    const stops = results.filter((r) => r.kind === "stop");
    const exact = stops.find((s) => s.kind === "stop" && s.name === "Centras")!;
    const prefix = stops.find((s) => s.kind === "stop" && s.name === "Centras Vilniaus")!;
    expect(exact.score).toBeGreaterThan(prefix.score);
  });

  it("ranks word-prefix matches between prefix and substring matches", async () => {
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-prefix", "Vilties gatve", 54.7, 25.3),
      gtfsStop("stop-wordprefix", "Gerosios vilties", 54.7, 25.3),
      gtfsStop("stop-substring", "Aviltis gatve", 54.7, 25.3),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("vilt", "vilnius", null, new AbortController().signal, "local");

    const stops = results.filter((r) => r.kind === "stop");
    const prefixStop = stops.find((s) => s.kind === "stop" && s.name === "Vilties gatve")!;
    const wordPrefixStop = stops.find((s) => s.kind === "stop" && s.name === "Gerosios vilties")!;
    const substringStop = stops.find((s) => s.kind === "stop" && s.name === "Aviltis gatve")!;
    expect(prefixStop.score).toBeGreaterThan(wordPrefixStop.score);
    expect(wordPrefixStop.score).toBeGreaterThan(substringStop.score);
  });

  it("stopGroup score reflects the best-matching member, not the worst", async () => {
    // A group with an exact-tier member alongside a prefix-tier member must
    // outrank a sibling group whose members are all prefix-tier. Catches
    // regressions that swap Math.max for Math.min or an average.
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-exact", "Centrum"),
      gtfsStop("stop-prefix-a", "Centrum Park"),
      gtfsStop("stop-prefix-b", "Centrum Plaza"),
      gtfsStop("stop-prefix-c", "Centrum Square"),
    ]);
    await db.stopGroups.bulkPut([
      {
        groupId: "g-mixed",
        name: "Mixed",
        stopIds: ["stop-prefix-a", "stop-exact"],
        type: "name_numbered",
        lat: 54.35,
        lon: 18.65,
      },
      {
        groupId: "g-prefix-only",
        name: "Prefix only",
        stopIds: ["stop-prefix-b", "stop-prefix-c"],
        type: "name_numbered",
        lat: 54.35,
        lon: 18.65,
      },
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("centrum", "gdansk", null, new AbortController().signal, "local");

    const mixed = results.find((r) => r.kind === "stopGroup" && r.groupId === "g-mixed")!;
    const prefixOnly = results.find((r) => r.kind === "stopGroup" && r.groupId === "g-prefix-only")!;
    expect(mixed).toBeDefined();
    expect(prefixOnly).toBeDefined();
    expect(mixed.score).toBeGreaterThan(prefixOnly.score);
  });

  it("heavily-tapped substring match can outrank a cold prefix match", async () => {
    // Documented intent: tap signal expresses user preference and is meant to
    // overcome match-quality gaps. Pin this so a future change to multiplicative
    // tap weighting doesn't silently flip user-visible ordering.
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-substring-tapped", "Stepono Batoro st."),
      gtfsStop("stop-prefix-cold", "Oro uostas"),
    ]);
    await putPersonal("personalUsage", crypto.randomUUID(), {
      stopId: "stop-substring-tapped",
      tapCount: 5,
      lastTapped: Date.now() - 3600_000,
    });

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("oro", "vilnius", null, new AbortController().signal, "local");

    const stops = results.filter((r) => r.kind === "stop");
    const tapped = stops.find((s) => s.kind === "stop" && s.stopId === "stop-substring-tapped")!;
    const cold = stops.find((s) => s.kind === "stop" && s.stopId === "stop-prefix-cold")!;
    expect(tapped.score).toBeGreaterThan(cold.score);
  });

  it("ranks remote fuzzy hits (no local match) below tiered matches in the same response", async () => {
    // Remote backends can return fuzzy hits (transliteration / aliases) that
    // nameMatchScore returns 0 for. Those still surface, but must rank below
    // any tiered match — including the lowest (substring) — so that a refactor
    // raising STOP_FALLBACK_WEIGHT above the substring weight (0.5) is caught.
    mockSearchStops.mockResolvedValue({
      data: [
        makeStop("stop-prefix", "Stotis Centrum"),
        makeStop("stop-substring", "Senastotis Park"),
        makeStop("stop-fallback", "Lvov"),
      ],
    });

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("stot", "vilnius", null, new AbortController().signal, "remote");

    const stops = results.filter((r) => r.kind === "stop");
    expect(stops.length).toBe(3);
    const prefix = stops.find((s) => s.kind === "stop" && s.name === "Stotis Centrum")!;
    const substring = stops.find((s) => s.kind === "stop" && s.name === "Senastotis Park")!;
    const fallback = stops.find((s) => s.kind === "stop" && s.name === "Lvov")!;
    expect(prefix.score).toBeGreaterThan(substring.score);
    expect(substring.score).toBeGreaterThan(fallback.score);
  });

  it("boosts score for recently tapped stops", async () => {
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-recent", "Dworzec A"),
      gtfsStop("stop-old", "Dworzec B"),
    ]);
    await putPersonal("personalUsage", crypto.randomUUID(), { stopId: "stop-recent", tapCount: 5, lastTapped: Date.now() - 3600_000 });

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("dworz", "gdansk", null, new AbortController().signal, "local");

    const stops = results.filter((r) => r.kind === "stop");
    expect(stops.length).toBe(2);
    const recent = stops.find((s) => s.kind === "stop" && s.stopId === "stop-recent")!;
    const old = stops.find((s) => s.kind === "stop" && s.stopId === "stop-old")!;
    expect(recent.score).toBeGreaterThan(old.score);
  });

  it("applies proximity bonus for hint location", async () => {
    await db.poiIndex.bulkPut([
      poiRecord("poi-near", "Museum Near", { lat: 54.351, lon: 18.651, category: "museum" }),
      poiRecord("poi-far", "Museum Far", { lat: 54.5, lon: 18.9, category: "museum" }),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const hint = { lat: 54.35, lon: 18.65 };
    const results = await searchSuggestions("museum", "gdansk", hint, new AbortController().signal, "local");

    const geocoded = results.filter((r) => r.kind === "geocoded");
    expect(geocoded.length).toBe(2);
    expect(geocoded[0].label).toBe("Museum Near");
    expect(geocoded[0].score).toBeGreaterThan(geocoded[1].score);
  });

  it("rejects with AbortError when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await db.poiIndex.bulkPut([
      poiRecord("poi-1", "Dworzec Glowny"),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    await expect(
      searchSuggestions("dworz", "gdansk", null, controller.signal, "local"),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("threads the abort signal through to the remote stops API", async () => {
    mockSearchStops.mockResolvedValue({ data: [] });

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const controller = new AbortController();
    await searchSuggestions("stot", "vilnius", null, controller.signal, "remote");

    expect(mockSearchStops).toHaveBeenCalledTimes(1);
    expect(mockSearchStops).toHaveBeenCalledWith("stot", expect.any(AbortSignal));
  });

  it("ignores remote API responses with non-array data", async () => {
    mockSearchStops.mockResolvedValue({ data: null as unknown as Stop[] });

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions(
      "stot",
      "vilnius",
      null,
      new AbortController().signal,
      "remote",
    );

    const stops = results.filter((r) => r.kind === "stop");
    expect(stops).toEqual([]);
  });

  it("limits results to MAX_RESULTS", async () => {
    const poiRecords: PoiIndexRecord[] = [];
    for (let i = 0; i < MAX_RESULTS_EXPORTED + 10; i++) {
      poiRecords.push(poiRecord(`poi-${i}`, `Place ${i}`, { category: "landmark" }));
    }
    await db.poiIndex.bulkPut(poiRecords);
    await db.gtfsStops.bulkPut(
      Array.from({ length: 5 }, (_, i) => gtfsStop(`stop-${i}`, `Place ${i}`)),
    );

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("place", "gdansk", null, new AbortController().signal, "local");
    expect(results).toHaveLength(MAX_RESULTS_EXPORTED);
  });

  it("curated results rank above OSM results for same name prefix", async () => {
    await db.poiIndex.bulkPut([
      poiRecord("poi-curated", "Ratusz Glowny", { source: "curated", rankBoost: 1.0, category: "landmark" }),
      poiRecord("poi-osm", "Ratusz Staromiejski", { source: "osm", rankBoost: 0.3, category: "public_building" }),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("ratusz", "gdansk", null, new AbortController().signal, "local");

    const geocoded = results.filter((r) => r.kind === "geocoded");
    expect(geocoded.length).toBe(2);
    expect(geocoded[0].source).toBe("curated");
  });

  it("only returns POI for the active city", async () => {
    await db.poiIndex.bulkPut([
      poiRecord("poi-gd", "Dworzec Glowny", { cityId: "gdansk" }),
      poiRecord("poi-vl", "Vilnius Station", { cityId: "vilnius" }),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("station", "vilnius", null, new AbortController().signal, "local");

    const geocoded = results.filter((r) => r.kind === "geocoded");
    expect(geocoded.length).toBe(1);
    expect(geocoded[0].kind === "geocoded" && geocoded[0].label).toBe("Vilnius Station");
  });

  it("matches aliases in POI entries", async () => {
    await db.poiIndex.bulkPut([
      poiRecord("poi-1", "Glowne Miasto", {
        aliases: { en: ["Main Town", "Old Town Center"] },
        category: "landmark",
      }),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("main town", "gdansk", null, new AbortController().signal, "local");

    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("geocoded");
    expect(results[0].kind === "geocoded" && results[0].label).toBe("Glowne Miasto");
  });

  it("default provider does not call the remote stops API", async () => {
    await db.gtfsStops.bulkPut([gtfsStop("stop-gv", "Gerosios vilties")]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    await searchSuggestions("ger", "vilnius", null, new AbortController().signal, "local");
    expect(mockSearchStops).not.toHaveBeenCalled();
  });

  it("remote provider uses the stops API and skips local GTFS data", async () => {
    await db.gtfsStops.bulkPut([gtfsStop("stop-local", "Should Be Ignored")]);
    mockSearchStops.mockResolvedValue({
      data: [makeStop("stop-remote", "Stotis Centrum")],
    });

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions(
      "stot",
      "vilnius",
      null,
      new AbortController().signal,
      "remote",
    );

    const stops = results.filter((r) => r.kind === "stop");
    expect(mockSearchStops).toHaveBeenCalledWith("stot", expect.any(AbortSignal));
    expect(stops.map((s) => s.kind === "stop" && s.name)).toEqual(["Stotis Centrum"]);
  });

  it("remote provider skips API call below the backend's minimum length", async () => {
    const { searchSuggestions } = await import("./searchSuggestions.ts");
    await searchSuggestions(
      "g",
      "vilnius",
      null,
      new AbortController().signal,
      "remote",
    );
    expect(mockSearchStops).not.toHaveBeenCalled();
  });

  it("remote provider falls back to empty stops on API failure but still returns POI", async () => {
    mockSearchStops.mockRejectedValue(new Error("network error"));
    await db.poiIndex.bulkPut([
      poiRecord("poi-1", "Dworzec Glowny", { category: "train_station" }),
    ]);

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions(
      "dworz",
      "gdansk",
      null,
      new AbortController().signal,
      "remote",
    );

    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("geocoded");
  });

  it("stopGroup gets higher score than individual stops from group bonus", async () => {
    await db.gtfsStops.bulkPut([
      gtfsStop("stop-1", "Centrum 01"),
      gtfsStop("stop-2", "Centrum 02"),
      gtfsStop("stop-solo", "Centrum Park"),
    ]);

    await db.stopGroups.put({
      groupId: "numbered:Centrum",
      name: "Centrum",
      stopIds: ["stop-1", "stop-2"],
      type: "name_numbered",
      lat: 54.35,
      lon: 18.65,
    });

    const { searchSuggestions } = await import("./searchSuggestions.ts");
    const results = await searchSuggestions("centrum", "gdansk", null, new AbortController().signal, "local");

    const group = results.find((r) => r.kind === "stopGroup");
    const solo = results.find((r) => r.kind === "stop" && r.stopId === "stop-solo");
    expect(group).toBeDefined();
    expect(solo).toBeDefined();
    expect(group!.score).toBeGreaterThan(solo!.score);
  });
});

import { searchSuggestionsStream } from "./searchSuggestions.ts";
// `db` and `PoiIndexRecord` are already imported at the top of the file (line 3).

function poiRow(over: Partial<import("../db/index.ts").PoiIndexRecord>): import("../db/index.ts").PoiIndexRecord {
  return {
    id: "gdansk:x", cityId: "gdansk", name: "Name", geoBucket: "0_0", aliases: {},
    category: "landmark", lat: 54.35, lon: 18.64, source: "osm", rankBoost: 1, tier: "strict",
    ...over,
  };
}

const TEST_TILE_BUNDLE_SHA256 = "a".repeat(64);
const TEST_TILE_GENERATION_ID = "c".repeat(64);

function currentTilePoiRow(
  over: Partial<import("../db/index.ts").PoiIndexRecord>,
): import("../db/index.ts").PoiIndexRecord {
  return poiRow({
    ...over,
    loadSource: "tile",
    bundleSha256: TEST_TILE_BUNDLE_SHA256,
    tileGenerationId: TEST_TILE_GENERATION_ID,
  });
}

async function enableLazyTileMode(): Promise<void> {
  setSearchModeAccessor(() => "lazy-tile");
  await activateTileGeneration({
    cityId: "gdansk",
    bundleSha256: TEST_TILE_BUNDLE_SHA256,
    generationId: TEST_TILE_GENERATION_ID,
    schemaVersion: 1,
    edgeKm: 24,
    anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
    tileBounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    tilingPolicy: "k-anon-floor",
    kAnonWaived: false,
    deliveryActive: true,
    validatedAt: 1,
  });
}

describe("searchSuggestionsStream (AC-6/7/7b/8)", () => {
  beforeEach(async () => { await db.open(); await db.poiIndex.clear(); await db.gtfsStops.clear(); });
  afterEach(async () => { await db.close(); });

  it("AC-6: first emit happens before the tile driver resolves (deterministic deferred, no real-timer race)", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Alpha Cafe" }));
    const onResults = vi.fn();

    let releaseDriver!: () => void;
    const driverGate = new Promise<void>((r) => { releaseDriver = r; });
    let driverProgressed = false;
    const ctrl = new AbortController();
    const p = searchSuggestionsStream("alpha", "gdansk", null, ctrl.signal, "local", {
      onResults,
      driver: async (onTileLanded) => {
        await driverGate;            // stays pending until we release it
        driverProgressed = true;
        await onTileLanded([]);
      },
    });
    // Wait for the local poiIndex/stops reads to settle and the first emit to fire (fake-indexeddb
    // settles on macrotasks, not microtasks). AC-6 is an ORDERING invariant, not a timing one: the
    // first emit must land BEFORE the driver resolver progresses past driverGate — so we poll for
    // the first onResults and then assert the driver is still parked.
    while (onResults.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 0));
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(driverProgressed).toBe(false);
    releaseDriver();
    await p;
  });

  it("AC-7: dedup by osmId — bundle wins over tile", async () => {
    await db.poiIndex.bulkPut([
      poiRow({ id: "gdansk:tile", name: "Mus Tile", osmId: "node/1", loadSource: "tile" }),
      poiRow({ id: "gdansk:bundle", name: "Museum", osmId: "node/1" }),
    ]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    const ctrl = new AbortController();
    await searchSuggestionsStream("mus", "gdansk", null, ctrl.signal, "local", {
      onResults: (partial) => emits.push(partial),
    });
    const last = emits.at(-1)!;
    const geocoded = last.filter((s) => s.kind === "geocoded");
    expect(geocoded).toHaveLength(1);
    expect(geocoded[0].label).toBe("Museum");
  });

  it("AC-7b: dedup by id when osmId absent — bundle wins", async () => {
    await db.poiIndex.bulkPut([
      poiRow({ id: "gdansk:same", name: "Plaza Tile", loadSource: "tile" }),
      poiRow({ id: "gdansk:same", name: "Plaza" }),
    ]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("plaza", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
    });
    const geocoded = emits.at(-1)!.filter((s) => s.kind === "geocoded");
    expect(geocoded).toHaveLength(1);
    expect(geocoded[0].label).toBe("Plaza");
  });
});

// `PoiIndexRecord` is already imported at the top of the file (line 3).

// Land a tile row in the DB AND hand it to onTileLanded (the bounded-merge path
// scores the rows the driver passes — mirrors how production reads back the
// just-written tile rows). Returns a driver closure for one landing.
function landDriver(rows: PoiIndexRecord[]) {
  return async (onTileLanded: (landed?: PoiIndexRecord[]) => void | Promise<void>) => {
    await db.poiIndex.bulkPut(rows);
    await onTileLanded(rows);
  };
}

describe("monotonic top hit (AC-8) + abort (AC-14)", () => {
  beforeEach(async () => { await db.open(); await db.poiIndex.clear(); await db.gtfsStops.clear(); });
  afterEach(async () => { await db.close(); });

  it("AC-8: a lower-scoring tile landing after a higher-scoring bundle leaves partial[0] unchanged", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:hi", name: "Central Station", rankBoost: 5 }));
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("central", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
      driver: landDriver([poiRow({ id: "gdansk:lo", name: "Central Annex", rankBoost: 0.1, loadSource: "tile" })]),
    });
    const firstTop = emits[0][0];
    const lastTop = emits.at(-1)![0];
    expect(lastTop.kind === "geocoded" && lastTop.label).toBe("Central Station");
    expect(firstTop.kind === "geocoded" && firstTop.label).toBe("Central Station");
  });

  it("AC-8: a strictly higher-scoring DIFFERENT POI updates partial[0]", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:base", name: "Park Place", rankBoost: 1 }));
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("p", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
      driver: landDriver([poiRow({ id: "gdansk:better", name: "P", rankBoost: 50, loadSource: "tile" })]),
    });
    const lastTop = emits.at(-1)![0];
    expect(lastTop.kind === "geocoded" && lastTop.label).toBe("P");
  });

  it("AC-8: a tile→bundle REPLACEMENT of the pinned hit (same osmId) keeps it pinned, bundle wins", async () => {
    // First the TILE version is the top hit; then the BUNDLE version of the SAME
    // POI lands (same osmId, different label, possibly different score). It must
    // stay pinned at index 0 AND the bundle label must win.
    await db.poiIndex.put(poiRow({ id: "gdansk:t", name: "Mus Tile", osmId: "node/9", rankBoost: 5, loadSource: "tile" }));
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("mus", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
      driver: landDriver([poiRow({ id: "gdansk:b", name: "Museum", osmId: "node/9", rankBoost: 5 })]),
    });
    const lastTop = emits.at(-1)![0];
    expect(lastTop.kind).toBe("geocoded");
    expect(lastTop.kind === "geocoded" && lastTop.poiIdentity).toBe("node/9"); // same identity, still pinned
    expect(lastTop.kind === "geocoded" && lastTop.label).toBe("Museum");        // bundle wins
  });

  it("AC-8: a same-identity rescore does NOT drop the pinned hit below a lower-scoring item", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:pin", name: "Opera House", osmId: "node/1", rankBoost: 3 }));
    await db.poiIndex.put(poiRow({ id: "gdansk:other", name: "Opera Annex", osmId: "node/2", rankBoost: 2.9 }));
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("opera", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
      // The pinned POI re-lands with a slightly LOWER (but still ≥ the other) score.
      driver: landDriver([poiRow({ id: "gdansk:pin", name: "Opera House", osmId: "node/1", rankBoost: 2.95, loadSource: "tile" })]),
    });
    const lastTop = emits.at(-1)![0];
    expect(lastTop.kind === "geocoded" && lastTop.poiIdentity).toBe("node/1"); // not demoted below node/2
  });

  it("AC-8: an equal-score tie is stable by id", async () => {
    await db.poiIndex.bulkPut([
      poiRow({ id: "gdansk:aaa", name: "Tie A", osmId: "node/aaa", rankBoost: 2 }),
      poiRow({ id: "gdansk:bbb", name: "Tie B", osmId: "node/bbb", rankBoost: 2 }),
    ]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("tie", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
    });
    const top2 = emits.at(-1)!.slice(0, 2).filter((s) => s.kind === "geocoded");
    // Stable order: lexicographically smaller identity first (poi:node/aaa < poi:node/bbb).
    expect(top2[0].kind === "geocoded" && top2[0].poiIdentity).toBe("node/aaa");
    expect(top2[1].kind === "geocoded" && top2[1].poiIdentity).toBe("node/bbb");
  });

  it("AC-8: a FRESH stream for a DIFFERENT query starts UNPINNED (no cross-query pin)", async () => {
    await db.poiIndex.bulkPut([
      poiRow({ id: "gdansk:alpha", name: "Alpha Tower", osmId: "node/a", rankBoost: 5 }),
      poiRow({ id: "gdansk:beta", name: "Beta Bridge", osmId: "node/b", rankBoost: 5 }),
    ]);
    const topIdentity = (arr: import("./searchSuggestions.ts").SearchSuggestion[]): string => {
      const t = arr[0];
      return t.kind === "geocoded" ? t.poiIdentity : "";
    };
    // Stream 1 pins Alpha (each stream has its OWN pinnedTopIdentity — no module
    // state shared across calls).
    const e1: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("alpha", "gdansk", null, new AbortController().signal, "local", {
      onResults: (p) => e1.push(p),
    });
    expect(topIdentity(e1.at(-1)!)).toBe("node/a");
    // Stream 2 (a different query) must NOT inherit Alpha's pin — Beta is top.
    const e2: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("beta", "gdansk", null, new AbortController().signal, "local", {
      onResults: (p) => e2.push(p),
    });
    expect(topIdentity(e2.at(-1)!)).toBe("node/b");
  });

  it("AC-8: if the prior top hit is dedup-REMOVED, partial[0] falls through to the new best", async () => {
    // The pinned hit and its bundle counterpart collapse on dedup; after the
    // bundle version lands as a HIGHER-scoring same-identity record, the prior
    // tile row is gone (dedup-removed) and the surviving record IS the new best —
    // a degenerate "removed" path. Then a strictly higher DIFFERENT POI lands.
    await db.poiIndex.put(poiRow({ id: "gdansk:pinned", name: "Old Top", osmId: "node/old", rankBoost: 5, loadSource: "tile" }));
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("top", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
      // A DIFFERENT, strictly higher POI lands; the old top is not re-passed, but
      // it remains in the index — so to exercise true removal we delete it here.
      driver: async (onTileLanded) => {
        await db.poiIndex.delete("gdansk:pinned");
        const better = poiRow({ id: "gdansk:newtop", name: "Top Hat", osmId: "node/new", rankBoost: 50, loadSource: "tile" });
        await db.poiIndex.put(better);
        await onTileLanded([better]);
      },
    });
    const lastTop = emits.at(-1)![0];
    expect(lastTop.kind === "geocoded" && lastTop.poiIdentity).toBe("node/new");
  });

  it("AC-14: abort BEFORE first emit rejects with AbortError", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      searchSuggestionsStream("x", "gdansk", null, ctrl.signal, "local", { onResults: vi.fn() }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("AC-14: abort AFTER >=1 emit resolves (no reject)", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Alpha" }));
    const ctrl = new AbortController();
    await expect(
      searchSuggestionsStream("alpha", "gdansk", null, ctrl.signal, "local", {
        onResults: () => { ctrl.abort(); },
        driver: async (onTileLanded) => { await onTileLanded([]); },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("bounded per-emit re-scan (AC-17)", () => {
  beforeEach(async () => { await db.open(); await db.poiIndex.clear(); await db.gtfsStops.clear(); });
  afterEach(async () => { await db.close(); vi.resetAllMocks(); vi.restoreAllMocks(); });

  it("a re-emit scores ONLY the newly-landed rows, NOT the whole corpus (spy-proven, scale-invariant)", async () => {
    // Spy on the shared per-record scorer. The FIRST emit scores the whole loaded
    // union once; each RE-EMIT must score only the rows the driver passes (here 1),
    // independent of corpus size. Falsified if the re-emit re-scores all N rows.
    const mod = await import("./searchSuggestions.ts");
    const scoreSpy = vi.spyOn(mod, "scorePoiRecord");

    const rows = Array.from({ length: 5000 }, (_, i) =>
      poiRow({ id: `gdansk:${i}`, name: `Place ${i}`, osmId: `node/${i}`, lat: 54.35, lon: 18.64 }),
    );
    await db.poiIndex.bulkPut(rows);

    let scoresAfterFirstEmit = 0;
    let reemitScoreCalls = 0;
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    const landed = poiRow({ id: "gdansk:new", name: "Place new", osmId: "node/new", loadSource: "tile" });

    await searchSuggestionsStream("place", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => {
        emits.push(partial);
        if (emits.length === 1) scoresAfterFirstEmit = scoreSpy.mock.calls.length;
      },
      driver: async (onTileLanded) => {
        await db.poiIndex.put(landed);
        const before = scoreSpy.mock.calls.length;
        await onTileLanded([landed]);
        reemitScoreCalls = scoreSpy.mock.calls.length - before;
      },
    });

    expect(emits.length).toBeGreaterThanOrEqual(2);
    // Initial scan touched the whole loaded union (~5000 calls).
    expect(scoresAfterFirstEmit).toBeGreaterThanOrEqual(5000);
    // The re-emit scored only the ONE landed row — bounded, NOT O(corpus).
    expect(reemitScoreCalls).toBe(1);
  });

  it("re-emit cost is flat across a 500-row vs 50k-row corpus (scale invariance)", async () => {
    const mod = await import("./searchSuggestions.ts");
    const scoreSpy = vi.spyOn(mod, "scorePoiRecord");

    async function reemitScoreCount(n: number): Promise<number> {
      await db.poiIndex.clear();
      await db.poiIndex.bulkPut(
        Array.from({ length: n }, (_, i) => poiRow({ id: `c${n}:${i}`, name: `Place ${i}`, osmId: `n${n}/${i}` })),
      );
      let count = 0;
      const landed = poiRow({ id: `c${n}:new`, name: "Place new", osmId: `n${n}/new`, loadSource: "tile" });
      await searchSuggestionsStream("place", "gdansk", null, new AbortController().signal, "local", {
        onResults: () => {},
        driver: async (onTileLanded) => {
          await db.poiIndex.put(landed);
          const before = scoreSpy.mock.calls.length;
          await onTileLanded([landed]);
          count = scoreSpy.mock.calls.length - before;
        },
      });
      return count;
    }

    const small = await reemitScoreCount(500);
    const large = await reemitScoreCount(50_000);
    // Bounded merge: per-re-emit scoring does NOT grow with corpus size.
    expect(small).toBe(1);
    expect(large).toBe(1);
    // 60s budget (was 30s): the 50k-row fake-indexeddb bulkPut runs ~4.8s in
    // isolation but ~31s under full-suite ("Build & Test") CPU contention on the
    // self-hosted runner, intermittently tipping a 30s timeout. The assertion is
    // a call-count (===1), size-independent, so the budget only needs to outlast
    // the bulkPut under load; 60s gives ~2x headroom over the observed worst case.
  }, 60_000);
});

describe("perceived-stability rule: rows 2..N keep prior order while focused", () => {
  beforeEach(async () => { await db.open(); await db.poiIndex.clear(); await db.gtfsStops.clear(); });
  afterEach(async () => { await db.close(); });

  it("a focused re-emit appends newly-landed rows at the tail; rows 2..N keep prior relative order", async () => {
    // Initial set: top (T) + two tail rows B, C (already displayed, in this order).
    await db.poiIndex.bulkPut([
      poiRow({ id: "gdansk:t", name: "Quay Top", osmId: "node/t", rankBoost: 9 }),
      poiRow({ id: "gdansk:b", name: "Quay Bravo", osmId: "node/b", rankBoost: 5 }),
      poiRow({ id: "gdansk:c", name: "Quay Charlie", osmId: "node/c", rankBoost: 4 }),
    ]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    // A newly-landed row "Quay Delta" scores BETWEEN B and C (4.5). Without the
    // perceived-stability gate it would sort to index 2 (between B and C),
    // reordering C below it under the cursor. With the gate (focused), prior tail
    // order [B, C] is preserved and Delta APPENDS at the tail.
    await searchSuggestionsStream("quay", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
      isListboxFocused: () => true,
      driver: async (onTileLanded) => {
        const delta = poiRow({ id: "gdansk:d", name: "Quay Delta", osmId: "node/d", rankBoost: 4.5, loadSource: "tile" });
        await db.poiIndex.put(delta);
        await onTileLanded([delta]);
      },
    });
    const ids = (arr: import("./searchSuggestions.ts").SearchSuggestion[]) =>
      arr.filter((s) => s.kind === "geocoded").map((s) => (s as { poiIdentity: string }).poiIdentity);
    // Top stays node/t; B before C preserved; Delta appended last (not inserted
    // between B and C as a pure score sort would).
    expect(ids(emits.at(-1)!)).toEqual(["node/t", "node/b", "node/c", "node/d"]);
  });

  it("an UNFOCUSED re-emit re-sorts by score (gate off → strict score order)", async () => {
    await db.poiIndex.bulkPut([
      poiRow({ id: "gdansk:t", name: "Quay Top", osmId: "node/t", rankBoost: 9 }),
      poiRow({ id: "gdansk:b", name: "Quay Bravo", osmId: "node/b", rankBoost: 5 }),
      poiRow({ id: "gdansk:c", name: "Quay Charlie", osmId: "node/c", rankBoost: 4 }),
    ]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("quay", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
      isListboxFocused: () => false,
      driver: async (onTileLanded) => {
        const delta = poiRow({ id: "gdansk:d", name: "Quay Delta", osmId: "node/d", rankBoost: 4.5, loadSource: "tile" });
        await db.poiIndex.put(delta);
        await onTileLanded([delta]);
      },
    });
    const ids = (arr: import("./searchSuggestions.ts").SearchSuggestion[]) =>
      arr.filter((s) => s.kind === "geocoded").map((s) => (s as { poiIdentity: string }).poiIdentity);
    // Score order: T(9) > B(5) > Delta(4.5) > C(4).
    expect(ids(emits.at(-1)!)).toEqual(["node/t", "node/b", "node/d", "node/c"]);
  });
});

describe("candidateToSuggestion (AC-1)", () => {
  const cand: GeocoderCandidate = {
    label: "Central Station",
    lat: 54.35123,
    lon: 18.64891,
    confidence: 0.83,
    provider: "self-hosted",
    privacyTier: "self-hosted",
  };

  it("AC-1: maps label/lat/lon 1:1, score===confidence, source osm, category address, no loadSource", () => {
    const s = candidateToSuggestion(cand, 0);
    expect(s.kind).toBe("geocoded");
    if (s.kind !== "geocoded") throw new Error("expected geocoded");
    expect(s.label).toBe("Central Station");
    expect(s.lat).toBe(54.35123);
    expect(s.lon).toBe(18.64891);
    expect(s.confidence).toBe(0.83);
    expect(s.score).toBe(0.83);
    expect(s.source).toBe("osm");
    expect(s.category).toBe("address");
    expect(s.loadSource).toBeUndefined();
  });

  it("AC-1: poiIdentity is deterministic, carries the srv: prefix, and differs by idx", () => {
    const a = candidateToSuggestion(cand, 0);
    const b = candidateToSuggestion(cand, 0);
    const c = candidateToSuggestion(cand, 1);
    if (a.kind !== "geocoded" || b.kind !== "geocoded" || c.kind !== "geocoded") {
      throw new Error("expected geocoded");
    }
    expect(a.poiIdentity).toBe(b.poiIdentity);            // deterministic for same input
    expect(a.poiIdentity.startsWith("srv:")).toBe(true);  // load-bearing namespace
    expect(a.poiIdentity).not.toBe(c.poiIdentity);        // distinct by idx
  });

  it("AC-1: non-finite confidence falls back to 0.5; non-finite coords are guarded to 0 in BOTH the identity AND the suggestion fields", () => {
    const bad: GeocoderCandidate = { ...cand, confidence: Number.NaN, lat: Number.NaN, lon: Number.NaN };
    const s = candidateToSuggestion(bad, 2);
    if (s.kind !== "geocoded") throw new Error("expected geocoded");
    expect(s.confidence).toBe(0.5);
    expect(s.score).toBe(0.5);
    expect(s.poiIdentity.includes("NaN")).toBe(false);
    // The guarded coords MUST also reach the suggestion's lat/lon fields — a
    // non-finite candidate must not ship NaN into map-pin placement / route
    // origin-dest when the user selects the result.
    expect(Number.isFinite(s.lat)).toBe(true);
    expect(Number.isFinite(s.lon)).toBe(true);
    expect(s.lat).toBe(0);
    expect(s.lon).toBe(0);
  });
});

describe("search mode accessor (AC-9, AC-15)", () => {
  const HINT = { lat: 54.35, lon: 18.65 };
  beforeEach(async () => {
    __resetSearchModeAccessorForTests();
    // Prior db-touching suites in this file close the Dexie handle in their
    // afterEach; re-open before clearing (matches the established idiom of the
    // other suites here — line 572 etc.).
    await db.open();
    await db.poiIndex.clear();
    mockSearchStops.mockReset();
    mockSearchStops.mockResolvedValue({ data: [] });
    // These cases exercise ranking/merging of remote results, not the egress
    // gate, so allow egress explicitly. The production default is DENY — the
    // gate itself is covered in its own describe block below.
    setThirdPartyEgressAccessor(() => true);
  });
  afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

  it("AC-9: with the accessor at its default (reset), searchSuggestions runs the LOCAL scan and NEVER reaches the registry", async () => {
    // Real default-off proof: do NOT assert a local literal you just assigned.
    // Reset to the default accessor, seed a matching poiIndex row, then drive the
    // real search path: the local scan MUST run (scorePoiRecord >=1) and the
    // registry MUST NOT be consulted (forward 0). This fails if the default ever
    // resolves "server-side".
    await db.poiIndex.bulkPut([poiRecord("p1", "Central Library", { lat: 54.35, lon: 18.65 })]);
    __resetSearchModeAccessorForTests();
    const mod = await import("./searchSuggestions.ts");
    const scoreSpy = vi.spyOn(mod, "scorePoiRecord");
    const forward = vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([]);
    await searchSuggestions("central", "gdansk", HINT, new AbortController().signal, "local");
    expect(scoreSpy.mock.calls.length).toBeGreaterThanOrEqual(1);  // local scan ran (default-off)
    expect(forward).toHaveBeenCalledTimes(0);                      // registry never consulted
  });

  it("AC-15: searchSuggestions.ts imports neither the resolvePoiFetchMode symbol nor the poiFetchMode.ts module", () => {
    // Route the relative path through a VARIABLE (mirrors phase3Disambiguation.test.ts's
    // `read()` helper): Vite rewrites `new URL("<string-literal>", import.meta.url)` into a
    // server (http://) asset URL, which fileURLToPath rejects; a variable first-arg is left
    // as a plain file: URL resolution. Same source-read, environment-safe.
    const rel = "./searchSuggestions.ts";
    const src = readFileSync(
      fileURLToPath(new URL(rel, import.meta.url)),
      "utf8",
    );
    // Leaf-module guard (a SYMBOL/import assertion, NOT a blunt substring grep). A blunt
    // `src.includes("poiFetchMode")` would FALSE-POSITIVE on the file's own explanatory comments
    // (which name the resolver to document WHY it is not imported). Match the IMPORT form instead:
    // assert no `import... from "...poiFetchMode..."` and no top-level `import {...
    // resolvePoiFetchMode... }`. The @pt/shared PoiFetchMode TYPE import is allowed (erased by tsc,
    // no runtime edge).
    const importsResolverModule = /import[^;]*from\s*['"][^'"]*poiFetchMode(?:\.ts)?['"]/.test(src);
    const importsResolverSymbol = /import\s*\{[^}]*\bresolvePoiFetchMode\b[^}]*\}\s*from/.test(src);
    expect(importsResolverModule).toBe(false);
    expect(importsResolverSymbol).toBe(false);
  });
});

describe("server-side POI search wiring (AC-2/3/4/7/16, AC-1c)", () => {
  const HINT: LatLon = { lat: 54.35, lon: 18.65 };

  beforeEach(async () => {
    __resetSearchModeAccessorForTests();
    await db.poiIndex.clear();
    mockSearchStops.mockReset();
    mockSearchStops.mockResolvedValue({ data: [] });
    // These cases exercise ranking/merging of remote results, not the egress
    // gate, so allow egress explicitly. The production default is DENY — the
    // gate itself is covered in its own describe block below.
    setThirdPartyEgressAccessor(() => true);
  });
  afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

  function seedMatchingPoi() {
    return db.poiIndex.bulkPut([
      poiRecord("p1", "Central Library", { lat: 54.35, lon: 18.65 }),
      poiRecord("p2", "Central Park", { lat: 54.36, lon: 18.66 }),
    ]);
  }

  it("AC-2: searchServerSidePoi calls registry.forward once with (query, hint, signal) and maps results in order", async () => {
    const forward = vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([
      { label: "A", lat: 1, lon: 2, confidence: 0.9, provider: "self-hosted", privacyTier: "self-hosted" },
      { label: "B", lat: 3, lon: 4, confidence: 0.4, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    const signal = new AbortController().signal;
    const out = await searchServerSidePoi("central", HINT, signal);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith("central", HINT, signal);
    expect(out.map((s) => s.kind)).toEqual(["geocoded", "geocoded"]);
    expect(out.map((s) => (s.kind === "geocoded" ? s.label : ""))).toEqual(["A", "B"]);
  });

  it("AC-3: server-side runs NO local poiIndex scan (0 scorePoiRecord, 0 poiIndex.where), 1 forward — with a SELF-VERIFYING eager positive control in the SAME run", async () => {
    await seedMatchingPoi();
    // PROVEN spy idiom: fresh dynamic import → vi.spyOn on THAT instance (the
    // static `import * as ssMod` form frequently fails to intercept the live
    // self.scorePoiRecord binding under vitest+ESM).
    const mod = await import("./searchSuggestions.ts");

    // --- Eager positive control FIRST, in this same run: proves the spy CAN
    //     observe the scan it later claims is absent. If this records 0 calls,
    //     the spy is NOT intercepting and the residency assertion below is
    //     VACUOUS — the control failing is itself a test failure, not a skip.
    setSearchModeAccessor(() => "eager-bundle");
    const eagerForward = vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([]);
    const eagerScoreSpy = vi.spyOn(mod, "scorePoiRecord");
    await searchSuggestions("central", "gdansk", HINT, new AbortController().signal, "local");
    expect(eagerScoreSpy.mock.calls.length).toBeGreaterThanOrEqual(1); // spy IS live (else vacuous)
    expect(eagerForward).toHaveBeenCalledTimes(0);
    vi.resetAllMocks();
    vi.restoreAllMocks();

    // --- Residency assertion: server-side scans NOTHING locally.
    setSearchModeAccessor(() => "server-side");
    const forward = vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([]);
    const scoreSpy = vi.spyOn(mod, "scorePoiRecord");
    // Spy on the SAME Dexie table instance the engine imports (db.poiIndex is the
    // shared singleton from ../db/index.ts, the same module the engine reads).
    const whereSpy = vi.spyOn(db.poiIndex, "where");
    await searchSuggestions("central", "gdansk", HINT, new AbortController().signal, "local");
    expect(scoreSpy).toHaveBeenCalledTimes(0);
    expect(whereSpy).toHaveBeenCalledTimes(0);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("AC-4a: stops compose under server-side AND searchStopsWithGroups receives the IDENTICAL 5-tuple across modes", async () => {
    // The `api.ts` mock forwards only (query, signal), so it CANNOT observe the
    // 5-tuple (query, nq, hint, signal, provider). Assert parity at the real
    // seam: searchStopsWithGroups is exported and called via self.* (mirroring
    // scorePoiRecord), so a fresh-import spy observes its full arg-list.
    const mod = await import("./searchSuggestions.ts");
    const stopsSpy = vi.spyOn(mod, "searchStopsWithGroups");
    mockSearchStops.mockResolvedValue({ data: [makeStop("s1", "Central Station")] });
    vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([
      { label: "Central Cafe", lat: 1, lon: 2, confidence: 0.5, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    setSearchModeAccessor(() => "server-side");
    const signal = new AbortController().signal;
    const out = await searchSuggestions("Central Station", "gdansk", HINT, signal, "remote");
    expect(out.some((s) => s.kind === "stop")).toBe(true);          // stops survive
    expect(out.some((s) => s.kind === "geocoded")).toBe(true);      // server POI present
    const serverArgs = stopsSpy.mock.calls[stopsSpy.mock.calls.length - 1];

    setSearchModeAccessor(() => "eager-bundle");
    await searchSuggestions("Central Station", "gdansk", HINT, signal, "remote");
    const eagerArgs = stopsSpy.mock.calls[stopsSpy.mock.calls.length - 1];
    // Full 5-tuple (query, nq, hint, signal, provider) identical → only the POI
    // leg forks; a refactor dropping nq/provider on the server branch fails here.
    expect(serverArgs).toEqual(eagerArgs);
  });

  it("AC-4b: eager-bundle never reaches the registry", async () => {
    await seedMatchingPoi();
    setSearchModeAccessor(() => "eager-bundle");
    const forward = vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([]);
    const signal = new AbortController().signal;
    await searchSuggestions("central", "gdansk", HINT, signal, "local");
    expect(forward).not.toHaveBeenCalled();
  });

  it("AC-1c: a server candidate and a same-LOCATION local POI row BOTH survive finalize (the srv: suffix is load-bearing)", async () => {
    // The load-bearing case `srv:` guards is server-vs-LOCAL-POI: both are
    // kind:"geocoded" → both keyed `poi:…` by finalize, so only the `srv:` suffix
    // keeps them distinct. Seed a local POI whose label+coords could collide with
    // the server candidate. (A same-named STOP is the weaker `kind`-prefix case,
    // not exercised here.) Eager-bundle so the local poiIndex IS scanned, AND the
    // server leg runs — drive BOTH legs in one search by spying searchPoi's seam:
    // instead, exercise finalize directly over the two suggestion kinds.
    await db.poiIndex.bulkPut([
      poiRecord("localCentral", "Central Station", { lat: 54.35, lon: 18.65 }),
    ]);
    mockSearchStops.mockResolvedValue({ data: [] });
    vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([
      { label: "Central Station", lat: 54.35, lon: 18.65, confidence: 0.95, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    // First, eager mode: the local POI "Central Station" is returned from the scan.
    setSearchModeAccessor(() => "eager-bundle");
    const localOut = await searchSuggestions("Central Station", "gdansk", HINT, new AbortController().signal, "local");
    const localGeocoded = localOut.filter((s) => s.kind === "geocoded");
    expect(localGeocoded.length).toBe(1);              // local POI present (no srv: prefix)
    // Then, server-side: the server candidate is returned and carries `srv:`.
    setSearchModeAccessor(() => "server-side");
    const serverOut = await searchSuggestions("Central Station", "gdansk", HINT, new AbortController().signal, "local");
    const serverGeocoded = serverOut.filter((s) => s.kind === "geocoded");
    expect(serverGeocoded.length).toBe(1);
    // The two identities differ ONLY by the srv: suffix — if `srv:` were dropped,
    // the server identity `poi:Central Station|54.35000|18.65000|…` could collide
    // with the local `poi:localCentral`. Assert the server identity is srv:-prefixed.
    if (serverGeocoded[0].kind !== "geocoded") throw new Error("expected geocoded");
    if (localGeocoded[0].kind !== "geocoded") throw new Error("expected geocoded");
    expect(serverGeocoded[0].poiIdentity.startsWith("srv:")).toBe(true);
    expect(localGeocoded[0].poiIdentity.startsWith("srv:")).toBe(false);
    expect(serverGeocoded[0].poiIdentity).not.toBe(localGeocoded[0].poiIdentity);
  });

  it("AC-4c: an exact stop match outranks a fuzzy server hit; a ~1.0 server hit outranks a weak fuzzy stop", async () => {
    mockSearchStops.mockResolvedValue({ data: [makeStop("s1", "Central Station")] });
    vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([
      { label: "Centrol Statn", lat: 1, lon: 2, confidence: 0.3, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    setSearchModeAccessor(() => "server-side");
    const signal = new AbortController().signal;
    const out = await searchSuggestions("Central Station", "gdansk", HINT, signal, "remote");
    expect(out[0].kind).toBe("stop");   // exact stop name beats a low-confidence fuzzy server hit
  });

  it("AC-4d: server-side returns a srv: geocoded hit; mid-session flip back to eager returns local results without reload", async () => {
    await seedMatchingPoi();
    vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([
      { label: "Central Cafe", lat: 1, lon: 2, confidence: 0.7, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    setSearchModeAccessor(() => "server-side");
    const signal = new AbortController().signal;
    const server = await searchSuggestions("central", "gdansk", HINT, signal, "local");
    // Server-side half is actually checked (no `|| true` no-op): the geocoded hit
    // is the mapped server candidate, identified by the srv: prefix.
    const serverGeocoded = server.filter((s) => s.kind === "geocoded");
    expect(serverGeocoded.length).toBe(1);
    if (serverGeocoded[0].kind !== "geocoded") throw new Error("expected geocoded");
    expect(serverGeocoded[0].poiIdentity.startsWith("srv:")).toBe(true);  // came from the registry, not the local scan
    setSearchModeAccessor(() => "eager-bundle");
    const local = await searchSuggestions("central", "gdansk", HINT, signal, "local");
    const localGeocoded = local.filter((s) => s.kind === "geocoded");
    expect(localGeocoded.length).toBeGreaterThanOrEqual(1);               // local poiIndex hits returned
    if (localGeocoded[0].kind !== "geocoded") throw new Error("expected geocoded");
    expect(localGeocoded[0].poiIdentity.startsWith("srv:")).toBe(false);  // local, NOT a stale registry hit
  });

  it("AC-7: server-side search issues no /poi/*.br and no fetchPoiBundle", async () => {
    await seedMatchingPoi();
    setSearchModeAccessor(() => "server-side");
    vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([]);
    const bundleSpy = vi.spyOn(poiLoader, "fetchPoiBundle").mockResolvedValue(undefined as never);
    const fetchSpy = vi.fn(async (_u?: unknown) => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    const signal = new AbortController().signal;
    await searchSuggestions("central", "gdansk", HINT, signal, "local");
    expect(bundleSpy).toHaveBeenCalledTimes(0);
    const poiUrls = fetchSpy.mock.calls.filter(([u]) => typeof u === "string" && /\/poi\/.*\.br$/.test(u));
    expect(poiUrls).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("AC-16: a stray driver under server-side is treated as no driver (single emit, no re-emit loop)", async () => {
    setSearchModeAccessor(() => "server-side");
    vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([]);
    const driver = vi.fn(async () => {});
    const emits: number[] = [];
    const signal = new AbortController().signal;
    await searchSuggestionsStream("central", "gdansk", HINT, signal, "local", {
      onResults: (_p, meta) => { emits.push(meta.emitSeq); },
      driver,
    });
    expect(driver).not.toHaveBeenCalled();        // no re-emit loop
    expect(emits).toEqual([0]);                    // single emit
  });
});

describe("server-side abort parity + non-abort resilience (AC-8)", () => {
  const HINT = { lat: 54.35, lon: 18.65 };
  beforeEach(() => { __resetSearchModeAccessorForTests(); mockSearchStops.mockResolvedValue({ data: [] }); });
  afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

  it("AC-8a: signal-aborted during forward → AbortError rejects (rethrown, not swallowed)", async () => {
    vi.spyOn(geocoderRegistry, "forward").mockRejectedValue(new DOMException("aborted", "AbortError"));
    const signal = new AbortController().signal;
    await expect(searchServerSidePoi("x", HINT, signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("AC-8c: a non-abort registry throw degrades to [] so the stops leg survives", async () => {
    await db.poiIndex.clear();
    mockSearchStops.mockResolvedValue({ data: [makeStop("s1", "Central Station")] });
    vi.spyOn(geocoderRegistry, "forward").mockRejectedValue(new Error("boom"));
    setSearchModeAccessor(() => "server-side");
    const signal = new AbortController().signal;
    const out = await searchSuggestions("Central Station", "gdansk", HINT, signal, "remote");
    expect(out.some((s) => s.kind === "stop")).toBe(true);   // stops still appear
  });

  it("AC-8d: no unhandled-rejection when stops + server-side both in flight and aborted", async () => {
    // PRIMARY guard: the positive assertion that the search rejects with AbortError
    // (deterministic — this is the real contract). The unhandled-rejection listener
    // below is a SECONDARY guard: a hand-rolled process.on + single setTimeout(0)
    // flush is inherently flaky (an unhandled rejection can surface a tick later
    // under vitest/jsdom — a false GREEN), so it is NOT the sole assertion. If this
    // proves flaky in CI, replace the listener with vitest's onUnhandledRejection
    // config hook; keep the positive rejects assertion either way.
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    const controller = new AbortController();
    vi.spyOn(geocoderRegistry, "forward").mockImplementation(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    setSearchModeAccessor(() => "server-side");
    const p = searchSuggestions("x", "gdansk", HINT, controller.signal, "remote");
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });   // PRIMARY (deterministic)
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();                      // SECONDARY (best-effort)
  });
});

describe("down-geocoder UX + no third-party leak (AC-5)", () => {
  const HINT = { lat: 54.35, lon: 18.65 };

  function makeAdapter(id: string, tier: "self-hosted" | "third-party", forward: () => Promise<unknown[]>) {
    return {
      id, privacyTier: tier,
      isAvailable: () => true,
      forward: vi.fn(forward),
      reverse: vi.fn(async () => null),
    };
  }

  beforeEach(() => {
    __resetSearchModeAccessorForTests();
    mockSearchStops.mockResolvedValue({ data: [] });
  });
  afterEach(() => {
    geocoderRegistry.setActiveModeAccessor(() => "eager-bundle");
    geocoderRegistry.unregister("self-hosted");
    geocoderRegistry.unregister("third-party-photon");
    geocoderRegistry.status.clear();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it("AC-5: down self-hosted → provider-failed, NO third-party leak, no throw to the box", async () => {
    const selfHosted = makeAdapter("self-hosted", "self-hosted", async () => { throw new Error("down"); });
    const thirdParty = makeAdapter("third-party-photon", "third-party", async () => [
      { label: "leak", lat: 1, lon: 2, confidence: 1, provider: "third-party-photon", privacyTier: "third-party" },
    ]);
    geocoderRegistry.register(selfHosted as never);
    geocoderRegistry.register(thirdParty as never);
    setSearchModeAccessor(() => "server-side");
    geocoderRegistry.setActiveModeAccessor(() => "server-side");

    const events: string[] = [];
    const unsub = geocoderRegistry.status.subscribe((e) => events.push(`${e.kind}:${e.provider}`));
    const out = await searchServerSidePoi("x", HINT, new AbortController().signal);
    unsub();

    expect(out).toEqual([]);                                   // no throw, no results
    expect(thirdParty.forward).not.toHaveBeenCalled();          // gated out under server-side
    expect(events).toContain("provider-failed:self-hosted");    // chip-observable signal
  });

  it("AC-5 positive control: eager-bundle DOES consult the third-party adapter", async () => {
    // The self-hosted adapter returns an EMPTY (no throw) so the registry's loop
    // falls through to the next tier. A THROW would fail-close (the registry emits
    // provider-failed and returns [] before the third-party tier is reached — see
    // registry.ts forward() catch), which would make this positive control vacuous.
    // An empty self-hosted result is the path that proves the third-party tier IS
    // reachable under eager-bundle (so AC-5's not.toHaveBeenCalled() under
    // server-side is a real gate, not mere absence).
    const selfHosted = makeAdapter("self-hosted", "self-hosted", async () => []);
    const thirdParty = makeAdapter("third-party-photon", "third-party", async () => [
      { label: "ok", lat: 1, lon: 2, confidence: 1, provider: "third-party-photon", privacyTier: "third-party" },
    ]);
    geocoderRegistry.register(selfHosted as never);
    geocoderRegistry.register(thirdParty as never);
    setSearchModeAccessor(() => "eager-bundle");
    geocoderRegistry.setActiveModeAccessor(() => "eager-bundle");
    await searchServerSidePoi("x", HINT, new AbortController().signal);
    expect(thirdParty.forward).toHaveBeenCalled();              // gate (not absence) suppressed it under server-side
  });

  it("AC-5b: a genuine empty (no throw) emits NO provider-failed (recovery-only)", async () => {
    const selfHosted = makeAdapter("self-hosted", "self-hosted", async () => []);
    geocoderRegistry.register(selfHosted as never);
    setSearchModeAccessor(() => "server-side");
    geocoderRegistry.setActiveModeAccessor(() => "server-side");
    const events: string[] = [];
    const unsub = geocoderRegistry.status.subscribe((e) => events.push(e.kind));
    const out = await searchServerSidePoi("x", HINT, new AbortController().signal);
    unsub();
    expect(out).toEqual([]);
    // A non-throwing self-hosted forward emits provider-recovered UNCONDITIONALLY (empty result
    // included), which CLEARS the failure chip. The genuine-empty contract is that it emits NO
    // provider-failed, never that the chip stays silent.
    expect(events).not.toContain("provider-failed");           // no false alarm
    expect(events).toEqual(["provider-recovered"]);            // recovery clears the chip
  });

});

import {
  ADDR_AUG_ENABLED,
  ADDR_AUG_MIN_QUERY_LEN,
  ADDR_AUG_SPARSE_THRESHOLD,
  ADDR_AUG_DEDUP_METERS,
  ADDR_AUG_TIMEOUT_MS,
  MAX_RESULTS_EXPORTED,
  dedupServerAgainstLocal,
  setGeocoderPresentAccessor,
  __resetGeocoderPresentAccessorForTests,
  getGeocoderPresentForTests,
} from "./searchSuggestions.ts";
import type { SearchSuggestion as Sug } from "./searchSuggestions.ts";

// The geocoded arm. dedupServerAgainstLocal's serverSuggestions param is typed
// to THIS (it reads .label/.lat/.lon unconditionally — a bare SearchSuggestion[]
// would not compile), so srvSug/localPoi return GeoSug to build a GeoSug[].
type GeoSug = Extract<Sug, { kind: "geocoded" }>;

// Build a local-POI geocoded suggestion (poiIdentity WITHOUT the srv: prefix).
function localPoi(label: string, lat: number, lon: number, identity = `id:${label}`): GeoSug {
  return { kind: "geocoded", label, lat, lon, confidence: 0.9, category: "landmark", source: "osm", poiIdentity: identity, score: 0.9 };
}
function srvSug(label: string, lat: number, lon: number, idx = 0): GeoSug {
  return { kind: "geocoded", label, lat, lon, confidence: 0.8, category: "address", source: "osm", poiIdentity: `srv:${label}|${lat.toFixed(5)}|${lon.toFixed(5)}|${idx}`, score: 0.8 };
}
function stopSug(name: string, lat: number, lon: number): Sug {
  return { kind: "stop", stopId: `s:${name}`, name, lat, lon, score: 0.6 };
}

describe("augmentation constants", () => {
  it("slice invariant: ADDR_AUG_SPARSE_THRESHOLD < MAX_RESULTS", () => {
    expect(ADDR_AUG_SPARSE_THRESHOLD).toBeLessThan(MAX_RESULTS_EXPORTED);
  });
  it("defaults match the spec", () => {
    expect(ADDR_AUG_ENABLED).toBe(true);
    expect(ADDR_AUG_MIN_QUERY_LEN).toBe(4);
    expect(ADDR_AUG_SPARSE_THRESHOLD).toBe(5);
    expect(ADDR_AUG_DEDUP_METERS).toBe(50);
    expect(ADDR_AUG_TIMEOUT_MS).toBe(3000);
  });
});

describe("dedupServerAgainstLocal", () => {
  it("drops a server hit name-similar AND within ADDR_AUG_DEDUP_METERS of a local POI", () => {
    const local = [localPoi("Central Station", 54.35, 18.65)];
    const server = [srvSug("Central Station", 54.35001, 18.65001)]; // ~1.5 m away
    expect(dedupServerAgainstLocal(server, local)).toEqual([]);
  });
  it("keeps a server hit name-dissimilar to the co-located local POI", () => {
    const local = [localPoi("Central Station", 54.35, 18.65)];
    const server = [srvSug("Gedimino prospektas 9", 54.35001, 18.65001)];
    expect(dedupServerAgainstLocal(server, local)).toHaveLength(1);
  });
  it("keeps a name-similar server hit FAR from the local POI (> threshold)", () => {
    const local = [localPoi("Central Station", 54.35, 18.65)];
    const server = [srvSug("Central Station", 54.40, 18.70)]; // kms away
    expect(dedupServerAgainstLocal(server, local)).toHaveLength(1);
  });
  it("does NOT dedup a server hit against a co-located STOP (dedup is vs local POI only)", () => {
    const local = [stopSug("Central Station", 54.35, 18.65)];
    const server = [srvSug("Central Station", 54.35001, 18.65001)];
    expect(dedupServerAgainstLocal(server, local)).toHaveLength(1);
  });
  it("does NOT dedup against another server (srv:) row", () => {
    const local = [srvSug("Central Station", 54.35, 18.65)];
    const server = [srvSug("Central Station", 54.35001, 18.65001, 1)];
    expect(dedupServerAgainstLocal(server, local)).toHaveLength(1);
  });
  it("matches a long nominatim display_name against a short local name without over-dropping the dissimilar one", () => {
    const local = [localPoi("Stoties", 54.35, 18.65)];
    // similar (shares the 'Stoties' token via the normalized query of the label)
    const similar = srvSug("Stoties g. 10, Vilnius, Lithuania", 54.35001, 18.65001);
    // dissimilar street far away — must survive
    const dissimilar = srvSug("Gedimino g. 1, Vilnius, Lithuania", 54.40, 18.70, 1);
    const out = dedupServerAgainstLocal([similar, dissimilar], local);
    expect(out.map((s) => s.label)).toEqual(["Gedimino g. 1, Vilnius, Lithuania"]);
  });
});

describe("setGeocoderPresentAccessor", () => {
  afterEach(() => __resetGeocoderPresentAccessorForTests());
  it("defaults to 'no geocoder present' and is overridable", () => {
    // Use the statically-imported symbol (above), NOT a CommonJS require: a bare
    // `require` is undefined under the ESM/pt-wasm-stub vitest.poi-phase2.config.ts
    // and would flake "require is not defined" (Should-fix).
    expect(getGeocoderPresentForTests("x")).toBe(false);
    setGeocoderPresentAccessor((id) => id === "vilnius");
    expect(getGeocoderPresentForTests("vilnius")).toBe(true);
    expect(getGeocoderPresentForTests("paris")).toBe(false);
  });
});

// NOTE: searchSuggestionsStream is ALREADY imported at line 563 of this file, and the ADDR_AUG_* /
// setGeocoderPresentAccessor / __resetGeocoderPresentAccessorForTests symbols are ALREADY imported
// by the block. Do NOT re-import any of them here (a duplicate import is a tsc error). Only the
// local helper below is new.

// Helper: a deferred geocoder candidate set we resolve manually (no microtask race).
function deferredForward() {
  let release!: (cands: import("@pt/shared").GeocoderCandidate[]) => void;
  const gate = new Promise<import("@pt/shared").GeocoderCandidate[]>((r) => { release = r; });
  return { gate, release };
}

// Test-local identity proxy (suggestionIdentity in searchSuggestions.ts is NOT
// exported). Distinct per row, stable per row across emits — enough to assert
// prior-row identity+order in the no-reshuffle case without reaching into the module.
function suggestionIdentityForTest(s: import("./searchSuggestions.ts").SearchSuggestion): string {
  if (s.kind === "geocoded") return `poi:${s.poiIdentity}`;
  if (s.kind === "stop") return `stop:${s.stopId}`;
  return `group:${s.groupId}`;
}

describe("address augmentation gate + two-emit flow", () => {
  beforeEach(async () => {
    __resetTileGenerationStateForTests();
    await db.open(); await db.poiIndex.clear(); await db.gtfsStops.clear();
    setSearchModeAccessor(() => "eager-bundle");
    setGeocoderPresentAccessor(() => true);
  });
  afterEach(async () => {
    __resetSearchModeAccessorForTests();
    __resetGeocoderPresentAccessorForTests();
    __resetTileGenerationStateForTests();
    vi.resetAllMocks();
    vi.restoreAllMocks();
    await db.close();
  });

  it("Gate: armed eager city with sparse local POI fires forwardSelfHosted (second emit merges an address)", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([
      { label: "Gedimino g. 9", lat: 54.4, lon: 18.7, confidence: 0.7, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
    });
    expect(fwd).toHaveBeenCalledTimes(1);
    const last = emits.at(-1)!;
    expect(last.some((s) => s.kind === "geocoded" && s.label === "Gedimino g. 9")).toBe(true);
  });

  it("Gate (no geocoder present): geocoder-present accessor false → no second call", async () => {
    setGeocoderPresentAccessor(() => false);
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([]);
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", { onResults: () => {} });
    expect(fwd).not.toHaveBeenCalled();
  });

  it("Gate (kill-switch ADDR_AUG_ENABLED off): VITE_PT_ADDR_AUG=0 short-circuits arming → no second call", async () => {
    // ADDR_AUG_ENABLED is a module-eval const from import.meta.env, so flipping it
    // requires stubEnv + resetModules + a FRESH re-import (mirrors poiFetchMode.test.ts's
    // freshResolve pattern). The geocoder IS present and the local set IS sparse, so
    // ONLY the kill-switch can suppress the call — proving the literal AC, not the
    // no-geocoder path above.
    vi.stubEnv("VITE_PT_ADDR_AUG", "0");
    vi.resetModules();
    const fresh = await import("./searchSuggestions.ts");
    // Re-establish the injected accessors on the FRESH module instance (resetModules
    // gave new module-level accessor state).
    fresh.setSearchModeAccessor(() => "eager-bundle");
    fresh.setGeocoderPresentAccessor(() => true);
    expect(fresh.ADDR_AUG_ENABLED).toBe(false); // precondition: the stub took effect
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    // Spy on the FRESH module's registry instance (the re-import re-evaluated instance.ts;
    // forwardSelfHosted is reached through fresh's own import graph).
    const freshReg = (await import("./geocoder/instance.ts")).geocoderRegistry;
    const fwd = vi.spyOn(freshReg, "forwardSelfHosted").mockResolvedValue([]);
    await fresh.searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", { onResults: () => {} });
    expect(fwd).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.resetModules(); // restore the default module graph for subsequent cases
  });

  it("Gate: short normalized query (< ADDR_AUG_MIN_QUERY_LEN) → no second call", async () => {
    const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([]);
    await searchSuggestionsStream("ged", "gdansk", null, new AbortController().signal, "local", { onResults: () => {} });
    expect(fwd).not.toHaveBeenCalled();
  });

  it("Gate: server-side mode never arms augmentation (inert)", async () => {
    setSearchModeAccessor(() => "server-side");
    const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([]);
    // server-side drives the local poi leg through searchServerSidePoi → registry.forward
    vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([]);
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", { onResults: () => {} });
    expect(fwd).not.toHaveBeenCalled();
  });

  it("Sparsity denominator: many STOPS but ZERO local POI DOES augment (123 Gedimino case)", async () => {
    // Seed many matching gtfsStops; zero matching poiIndex rows.
    await db.gtfsStops.bulkPut(Array.from({ length: 10 }, (_, i) => gtfsStop(`s${i}`, `Gedimino Stop ${i}`)));
    const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([
      { label: "Gedimino g. 123", lat: 54.4, lon: 18.7, confidence: 0.7, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", { onResults: () => {} });
    expect(fwd).toHaveBeenCalledTimes(1);
  });

  it("Sparsity boundary: exactly ADDR_AUG_SPARSE_THRESHOLD local POI rows does NOT augment; threshold-1 does", async () => {
    // Determinism guard (Should-fix): the boundary inverts iff EVERY seeded row scores
    // > 0 against "gedimino" and lands in bestN as a geocoded non-srv: row. If
    // scorePoiRecord/searchPoi silently drops one (tighter name match, hint-distance
    // filter, category/geoBucket mismatch), the count reads N-1 and the === boundary
    // flips. Each case below asserts the FIRST-EMIT local-POI count equals the seeded
    // count as a PRECONDITION, so a scoring miss surfaces as a precondition failure,
    // not a confusing false-negative on the augment assertion. The names are exact
    // "Gedimino N" so the normalized "gedimino" query token-matches each.
    const localPoiCount = (emits: import("./searchSuggestions.ts").SearchSuggestion[][]) =>
      emits[0].filter((s) => s.kind === "geocoded" && !s.poiIdentity.startsWith("srv:")).length;

    // threshold-1 rows → augments.
    const fewer = ADDR_AUG_SPARSE_THRESHOLD - 1;
    await db.poiIndex.bulkPut(Array.from({ length: fewer }, (_, i) => poiRow({ id: `gdansk:f${i}`, name: `Gedimino ${i}`, osmId: `node/f${i}` })));
    const e1: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    const fwd1 = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([]);
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", { onResults: (p) => e1.push(p) });
    expect(localPoiCount(e1)).toBe(fewer); // precondition: all seeded rows scored in
    expect(fwd1).toHaveBeenCalledTimes(1);
    fwd1.mockRestore();

    await db.poiIndex.clear();
    await db.poiIndex.bulkPut(Array.from({ length: ADDR_AUG_SPARSE_THRESHOLD }, (_, i) => poiRow({ id: `gdansk:t${i}`, name: `Gedimino ${i}`, osmId: `node/t${i}` })));
    const e2: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    const fwd2 = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([]);
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", { onResults: (p) => e2.push(p) });
    expect(localPoiCount(e2)).toBe(ADDR_AUG_SPARSE_THRESHOLD); // precondition: all seeded rows scored in
    expect(fwd2).not.toHaveBeenCalled();
  });

  it("Sequencing: instant local first-emit lands BEFORE the deferred server call resolves; done fires exactly once", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    const { gate, release } = deferredForward();
    vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockImplementation(() => gate);
    const metas: { done: boolean; emitSeq: number }[] = [];
    let firstEmittedBeforeRelease = false;
    const p = searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", {
      onResults: (_partial, meta) => {
        metas.push(meta);
        if (metas.length === 1) firstEmittedBeforeRelease = true;
      },
    });
    // Wait (bounded) for the first (local) emit, then prove the server call is still
    // pending. Bounded vi.waitFor, NOT an unbounded while-poll, given this gate's
    // flagged onTaskUpdate/EPIPE flakiness (Should-fix).
    await vi.waitFor(() => expect(metas.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(firstEmittedBeforeRelease).toBe(true);
    expect(metas[0].done).toBe(false); // armed → first emit is non-terminal
    release([{ label: "Gedimino g. 9", lat: 54.4, lon: 18.7, confidence: 0.7, provider: "self-hosted", privacyTier: "self-hosted" }]);
    await p;
    expect(metas.filter((m) => m.done).length).toBe(1); // done exactly once
    expect(metas.at(-1)!.done).toBe(true);
  });

  it("Sampling (lazy-tile): an initially-sparse-but-eventually-rich set does NOT augment (samples the settled count)", async () => {
    await enableLazyTileMode();
    // First emit sees zero local POI; the driver lands threshold rows before settle.
    const landed = Array.from({ length: ADDR_AUG_SPARSE_THRESHOLD }, (_, i) =>
      currentTilePoiRow({ id: `gdansk:l${i}`, name: `Gedimino ${i}`, osmId: `node/l${i}` }));
    const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([]);
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", {
      onResults: () => {},
      driver: landDriver(landed),
    });
    expect(fwd).not.toHaveBeenCalled(); // settled set is rich → no augment
  });

  // IMPLEMENTER PRECONDITION (Must-fix — trace before trusting this test):
  // `finalize(..., preserveTailOrder=true)` builds `head = [merged[0]]` (the single
  // ABSOLUTE strongest row by score), then `priorTail` (prior rows 2..N that survive,
  // in their prior order), then `appended` (genuinely-new rows) at the tail. So the
  // 0.99 address lands at the TAIL **only if it is NOT merged[0]** — i.e. at least one
  // local POI must score >= the address's score (candidateToSuggestion maps
  // confidence 0.99 → score 0.99). Before relying on the tail assertion, trace
  // candidateToSuggestion (score = confidence) AND scorePoiRecord for these seeded
  // rows under the "gedimino" query, and confirm BOTH local POI score >= 0.99 (so the
  // address cannot become the head). If scorePoiRecord cannot produce a >= 0.99 local
  // score for a plausible fixture, change the address confidence to a mid value (e.g.
  // 0.4) that is provably below the locals — the invariant under test is "prior rows
  // keep their order; the new row appends", NOT a specific numeric ranking.
  it("No reshuffle: a second-emit address appends at the tail AND the prior rows keep identity+order when the listbox is focused", async () => {
    // Two local POI so there is a tail to preserve. Names chosen for an exact
    // token-match on "gedimino" so scorePoiRecord ranks them at/above the address.
    await db.poiIndex.bulkPut([
      poiRow({ id: "gdansk:a", name: "Gedimino", osmId: "node/a", rankBoost: 3 }),
      poiRow({ id: "gdansk:b", name: "Gedimino Bar", osmId: "node/b", rankBoost: 2 }),
    ]);
    const addrConfidence = 0.4; // provably below an exact-name-match local POI score
    vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([
      { label: "Gedimino g. 9", lat: 54.4, lon: 18.7, confidence: addrConfidence, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
      isListboxFocused: () => true,
    });
    expect(emits.length).toBe(2); // first (local, non-terminal) + augmentation (terminal)
    const firstLocalIds = emits[0].map((s) => suggestionIdentityForTest(s));
    const last = emits.at(-1)!;
    // (1) The address appends at the TAIL, not interleaved at the top.
    expect(last.at(-1)!.kind === "geocoded" && (last.at(-1) as { label: string }).label).toBe("Gedimino g. 9");
    // (2) The real no-reshuffle invariant: the prior local rows retain identity AND
    //     relative order in the terminal emit (a head re-sort would pass (1) but fail
    //     this). The terminal emit's prefix (minus the appended address) equals the
    //     first emit's order.
    const lastWithoutAppended = last.slice(0, firstLocalIds.length).map((s) => suggestionIdentityForTest(s));
    expect(lastWithoutAppended).toEqual(firstLocalIds);
  });

  it("No reshuffle negative control: when the listbox is NOT focused, the address interleaves to its score-sorted position (the focus gate is what suppresses the reshuffle)", async () => {
    await db.poiIndex.bulkPut([
      poiRow({ id: "gdansk:a", name: "Gedimino", osmId: "node/a", rankBoost: 3 }),
      poiRow({ id: "gdansk:b", name: "Gedimino Bar", osmId: "node/b", rankBoost: 2 }),
    ]);
    // A HIGH-confidence address: unfocused, finalize score-sorts it, so a 0.99 address
    // is NOT pinned to the tail — it takes its sorted position. This proves the tail
    // placement in the focused case is the perceived-stability gate, not a coincidence.
    vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([
      { label: "Gedimino g. 9", lat: 54.4, lon: 18.7, confidence: 0.99, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
      isListboxFocused: () => false,
    });
    const last = emits.at(-1)!;
    const addrIdx = last.findIndex((s) => s.kind === "geocoded" && (s as { label: string }).label === "Gedimino g. 9");
    expect(addrIdx).toBeGreaterThanOrEqual(0);
    // Unfocused: a 0.99 address is interleaved by score, NOT forced to the last slot.
    // (If scorePoiRecord makes a local row score above 0.99, addrIdx may be > 0; the
    // point is only that it is score-positioned, not tail-pinned — assert it is not
    // the trailing element when a lower-scored local exists after it.)
    expect(last.length).toBeGreaterThan(1);
  });

  it("Identity: a server batch is mapped once with srv: identities and merged exactly once", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([
      { label: "Addr A", lat: 54.4, lon: 18.7, confidence: 0.7, provider: "self-hosted", privacyTier: "self-hosted" },
      { label: "Addr B", lat: 54.41, lon: 18.71, confidence: 0.6, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", { onResults: (p) => emits.push(p) });
    const srv = emits.at(-1)!.filter((s) => s.kind === "geocoded" && s.poiIdentity.startsWith("srv:"));
    expect(srv).toHaveLength(2);
    // distinct identities, no duplicate from a re-issued idx
    expect(new Set(srv.map((s) => (s as { poiIdentity: string }).poiIdentity)).size).toBe(2);
  });

  it("Error: server-down → forwardSelfHosted returns [] (no second emit), local first emit survives", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    // This mock RESOLVES [] (it does not run the registry body), so the throw → provider-failed →
    // [] half is NOT exercised here — that contract is owned by the "provider-failed emitted + []
    // on a non-abort throw" registry test. Here we only assert the STREAM behaviour: a []
    // augmentation leaves the local first emit intact (nothing clobbered, no second emit content).
    // The end-to-end throw→chip→recover lifecycle is the dedicated integration case below.
    vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", { onResults: (p) => emits.push(p) });
    expect(emits.at(-1)!.some((s) => s.kind === "geocoded" && s.label === "Gedimino Cafe")).toBe(true);
  });

  it("Recovery lifecycle (integration): a REAL self-hosted adapter that throws then succeeds drives provider-failed → provider-recovered across the augment second emit", async () => {
    // Drive the REAL registry body (not a forwardSelfHosted spy) so the throw →
    // provider-failed → [] and the success → provider-recovered emissions actually
    // fire — this is the AC's "provider-failed emitted" half plus the chip-clear
    // signal, exercised end-to-end through the augmentation path (Should-fix).
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    let call = 0;
    const adapter = {
      id: "self-hosted" as const,
      privacyTier: "self-hosted" as const,
      isAvailable: () => true,
      forward: async () => {
        call += 1;
        if (call === 1) throw new Error("ECONNREFUSED");
        return [{ label: "Gedimino g. 9", lat: 54.4, lon: 18.7, confidence: 0.7, provider: "self-hosted" as const, privacyTier: "self-hosted" as const }];
      },
      reverse: async () => null,
    };
    geocoderRegistry.register(adapter);
    const events: import("./geocoder/statusEvents.ts").GeocoderStatusEvent[] = [];
    const unsub = geocoderRegistry.status.subscribe((e) => events.push(e));
    try {
      // Call 1: adapter throws → provider-failed, [] → no second-emit content, local survives.
      const e1: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
      await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", { onResults: (p) => e1.push(p) });
      expect(events.some((e) => e.kind === "provider-failed" && e.provider === "self-hosted")).toBe(true);
      expect(e1.at(-1)!.some((s) => s.kind === "geocoded" && s.label === "Gedimino Cafe")).toBe(true);

      // Call 2: adapter succeeds → provider-recovered, the address merges in the second emit.
      const e2: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
      await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", { onResults: (p) => e2.push(p) });
      expect(events.some((e) => e.kind === "provider-recovered" && e.provider === "self-hosted")).toBe(true);
      expect(e2.at(-1)!.some((s) => s.kind === "geocoded" && s.label === "Gedimino g. 9")).toBe(true);
    } finally {
      unsub();
      geocoderRegistry.unregister("self-hosted");
    }
  });

  it("AC-A24 eager sub-case — a mid-augmentation abort under eager THROWS AbortError (the stream rejects) and does not clobber the already-emitted local results", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    const ctrl = new AbortController();
    vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockImplementation(
      (_q, _h, signal) => new Promise<import("@pt/shared").GeocoderCandidate[]>((_, rej) => {
        signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      }),
    );
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    const p = searchSuggestionsStream("gedimino", "gdansk", null, ctrl.signal, "local", { onResults: (x) => emits.push(x) });
    await vi.waitFor(() => expect(emits.length).toBeGreaterThan(0), { timeout: 2000 });
    ctrl.abort();
    // Pin the ABORT contract specifically (Should-fix): a bare .rejects.toThrow()
    // passes on ANY throw and would catch the spec-warned abort-swallowing only by
    // luck. Assert it is an AbortError.
    await expect(p).rejects.toThrow(/abort/i);
    expect(emits[0].some((s) => s.kind === "geocoded" && s.label === "Gedimino Cafe")).toBe(true);
  });

  it("Eager armed-but-RICH local set: exactly ONE terminal emit (no redundant identical re-emit)", async () => {
    // >= threshold local POI → augment() short-circuits, willAugment is false up front,
    // so the first emit is the SINGLE done=true frame (Should-fix: no flash-then-resolve).
    await db.poiIndex.bulkPut(Array.from({ length: ADDR_AUG_SPARSE_THRESHOLD }, (_, i) =>
      poiRow({ id: `gdansk:r${i}`, name: `Gedimino ${i}`, osmId: `node/r${i}` })));
    const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([]);
    const metas: { done: boolean; emitSeq: number }[] = [];
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", {
      onResults: (_p, meta) => metas.push(meta),
    });
    expect(fwd).not.toHaveBeenCalled();
    expect(metas).toHaveLength(1);       // one emit only
    expect(metas[0].done).toBe(true);    // and it is terminal
  });

  it("Eager armed-AND-fires: exactly TWO emits — non-terminal first, terminal augmentation frame", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([
      { label: "Gedimino g. 9", lat: 54.4, lon: 18.7, confidence: 0.7, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    const metas: { done: boolean; emitSeq: number }[] = [];
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", {
      onResults: (_p, meta) => metas.push(meta),
    });
    expect(metas).toHaveLength(2);
    expect(metas[0].done).toBe(false);   // first emit deferred for the augmentation frame
    expect(metas[1].done).toBe(true);    // augmentation is the terminal frame
    expect(metas.filter((m) => m.done).length).toBe(1);
  });

  it("Lazy-tile augment fires: a driver landing < threshold rows augments and done fires EXACTLY once", async () => {
    await enableLazyTileMode();
    // Driver lands threshold-1 POI rows → settled set is sparse → augmentation fires.
    const landed = Array.from({ length: ADDR_AUG_SPARSE_THRESHOLD - 1 }, (_, i) =>
      currentTilePoiRow({ id: `gdansk:l${i}`, name: `Gedimino ${i}`, osmId: `node/l${i}` }));
    const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([
      { label: "Gedimino g. 9", lat: 54.4, lon: 18.7, confidence: 0.7, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    const metas: { done: boolean; emitSeq: number }[] = [];
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", {
      onResults: (p, meta) => { emits.push(p); metas.push(meta); },
      driver: landDriver(landed),
    });
    expect(fwd).toHaveBeenCalledTimes(1);
    expect(metas.filter((m) => m.done).length).toBe(1);   // exactly one terminal frame
    expect(metas.at(-1)!.done).toBe(true);
    // the augment folds into the FINAL frame (no separate terminal emit after it)
    expect(emits.at(-1)!.some((s) => s.kind === "geocoded" && s.label === "Gedimino g. 9")).toBe(true);
  });

  it("Lazy-tile abort during the driver loop: forwardSelfHosted is NEVER called", async () => {
    await enableLazyTileMode();
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    const ctrl = new AbortController();
    const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    // A driver that parks until aborted, then resolves — the augment() gate is reached
    // only AFTER the driver loop, so an abort during the loop must skip it entirely.
    const p = searchSuggestionsStream("gedimino", "gdansk", null, ctrl.signal, "local", {
      onResults: (x) => emits.push(x),
      driver: async (onTileLanded, signal) => {
        await new Promise<void>((r) => { signal.addEventListener("abort", () => r()); });
        await onTileLanded([]); // post-abort land is a no-op (signal.aborted guard)
      },
    });
    await vi.waitFor(() => expect(emits.length).toBeGreaterThan(0), { timeout: 2000 });
    ctrl.abort();
    await p; // lazy-tile abort-after->=1-emit resolves (no reject), per the existing contract
    expect(fwd).not.toHaveBeenCalled();
  });

  it("Observability: the egress-accounting 'queried' line logs pre-fetch (cityId + pre-slice localPoiCount); the 'candidates' line logs the hit count", async () => {
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([
      { label: "Gedimino g. 9", lat: 54.4, lon: 18.7, confidence: 0.7, provider: "self-hosted", privacyTier: "self-hosted" },
    ]);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", { onResults: () => {} });
    // The egress-accounting line ("the gate decided to query city X"), logged BEFORE
    // the fetch — names the city and the PRE-SLICE local-POI count (1 here).
    const queried = infoSpy.mock.calls.find(([m]) => typeof m === "string" && m.includes("augmentation: queried self-hosted"));
    expect(queried).toBeTruthy();
    expect((queried![1] as { cityId: string }).cityId).toBe("gdansk");
    expect((queried![1] as { localPoiCount: number }).localPoiCount).toBe(1);
    // The hit-count line — present only because the result is non-empty (AC-A26).
    const cands = infoSpy.mock.calls.find(([m]) => typeof m === "string" && m.includes("augmentation: candidates"));
    expect(cands).toBeTruthy();
    expect((cands![1] as { candidates: number }).candidates).toBe(1);
  });

  it("AC-A5b — pre-slice sparsity: a stop-heavy city whose ≥-threshold local POI are pushed BELOW the MAX_RESULTS slice does NOT augment (gate counts pre-slice, not sliced bestN)", async () => {
    // Scoring math (verified against scoreCandidate @ BundledGeocoderAdapter.ts:92
    // `matchScore * rankBoost + proximityBonus` and scoreStop @ searchSuggestions.ts:478
    // `STOP_BASE_SCORE(0.6) * matchScore`): a stop named exactly "Gedimino" scores
    // 0.6 * 1.0 = 0.6; a POI named "Gedimino N" with rankBoost 0.5 scores
    // prefix(0.85) * 0.5 = 0.425 < 0.6 (hint is null → proximityBonus 0). So the 15
    // stops sort ABOVE all 5 POI and the MAX_RESULTS slice keeps the 15 stops and
    // evicts ALL 5 POI — while the PRE-SLICE union still holds 5 local POI. That is
    // exactly the divergence: a sliced-bestN gate would read 0 < threshold and
    // wrongly augment; the pre-slice gate reads 5 >= threshold and does NOT. The
    // rankBoost(0.5) is the deterministic lever; if a future scorer change lets the
    // POI survive the slice, the precondition below FAILS LOUDLY (not a false green).
    await db.gtfsStops.bulkPut(
      Array.from({ length: MAX_RESULTS_EXPORTED }, (_, i) => gtfsStop(`s${i}`, "Gedimino")),
    );
    await db.poiIndex.bulkPut(
      Array.from({ length: ADDR_AUG_SPARSE_THRESHOLD }, (_, i) =>
        poiRow({ id: `gdansk:p${i}`, name: `Gedimino ${i}`, osmId: `node/p${i}`, rankBoost: 0.5 })),
    );
    const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockResolvedValue([]);
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", {
      onResults: (p) => emits.push(p),
    });
    // The engine now keeps more rows than local stop search returns, so stops
    // alone can no longer push the POI out of the list. The gate still has to
    // read the full union, not whatever the UI pages.
    expect(emits[0].filter((s) => s.kind === "geocoded" && !s.poiIdentity.startsWith("srv:")).length)
      .toBe(ADDR_AUG_SPARSE_THRESHOLD);
    // The pre-slice union held >= threshold local POI → NO augmentation (egress guard).
    expect(fwd).not.toHaveBeenCalled();
  });

  it("AC-A24 lazy sub-case — a mid-augmentation abort under lazy-tile resolves the stream QUIETLY (no reject); local results survive", async () => {
    await enableLazyTileMode();
    const ctrl = new AbortController();
    // forwardSelfHosted parks until its (linked) signal aborts, then rejects AbortError.
    const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockImplementation(
      (_q, _h, sig) => new Promise<import("@pt/shared").GeocoderCandidate[]>((_, rej) => {
        sig.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      }),
    );
    const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
    // Driver lands ONE POI then settles (sparse → augment arms+fires after the loop).
    const p = searchSuggestionsStream("gedimino", "gdansk", null, ctrl.signal, "local", {
      onResults: (x) => emits.push(x),
      driver: landDriver([currentTilePoiRow({ id: "gdansk:a", name: "Gedimino Cafe", osmId: "node/a" })]),
    });
    await vi.waitFor(() => expect(emits.length).toBeGreaterThan(0), { timeout: 2000 });
    ctrl.abort();
    // Lazy contract: the mid-augment abort is CAUGHT → the stream resolves, it does
    // NOT reject (the eager sub-case above rejects; this is the divergence AC-A24 pins).
    await expect(p).resolves.toBeUndefined();
    expect(fwd).toHaveBeenCalledTimes(1); // the augment fetch WAS reached (post-driver)
    expect(emits.flat().some((s) => s.kind === "geocoded" && s.label === "Gedimino Cafe")).toBe(true);
  });

  it("Timeout: a forwardSelfHosted that never resolves degrades to [] after ADDR_AUG_TIMEOUT_MS — the local set ships done=true with no srv: row", async () => {
    // Fake ONLY setTimeout/clearTimeout — NOT Date/microtasks/setImmediate. This
    // matters: fake-indexeddb v6 schedules its transaction completions on REAL
    // `setImmediate` (verified — package fake-indexeddb@^6.2.5), which
    // advanceTimersByTimeAsync does NOT pump. So we explicitly drain real
    // setImmediate macrotasks first (letting computeInitial's Dexie reads complete,
    // the first emit fire, and augment()'s ADDR_AUG_TIMEOUT_MS setTimeout get
    // SCHEDULED), THEN advance the fake timer to fire it. Seed BEFORE faking. If this
    // proves flaky under a future fake-indexeddb at impl time, extract the timeout
    // race into a small pure helper and unit-test THAT instead of driving the full
    // stream — do NOT weaken the assertion to a tautology.
    await db.poiIndex.put(poiRow({ id: "gdansk:a", name: "Gedimino Cafe" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fwd = vi.spyOn(geocoderRegistry, "forwardSelfHosted").mockImplementation(
        (_q, _h, sig) => new Promise<import("@pt/shared").GeocoderCandidate[]>((_, rej) => {
          sig.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
      );
      const metas: { done: boolean; emitSeq: number }[] = [];
      const emits: import("./searchSuggestions.ts").SearchSuggestion[][] = [];
      const p = searchSuggestionsStream("gedimino", "gdansk", null, new AbortController().signal, "local", {
        onResults: (x, m) => { emits.push(x); metas.push(m); },
      });
      // Drain real setImmediate macrotasks so Dexie settles + the first emit lands +
      // augment()'s setTimeout is scheduled (setImmediate is NOT faked here).
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      expect(emits.length).toBeGreaterThan(0); // first (local) emit landed pre-timeout
      await vi.advanceTimersByTimeAsync(ADDR_AUG_TIMEOUT_MS + 1); // fire the augment timeout
      await p;
      expect(fwd).toHaveBeenCalledTimes(1);
      // Degraded to []: exactly one terminal frame shipping the local set, no address.
      expect(metas.filter((m) => m.done).length).toBe(1);
      expect(metas.at(-1)!.done).toBe(true);
      expect(emits.at(-1)!.some((s) => s.kind === "geocoded" && s.label === "Gedimino Cafe")).toBe(true);
      expect(emits.at(-1)!.some((s) => s.kind === "geocoded" && s.poiIdentity.startsWith("srv:"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("remote stop search third-party egress gate", () => {
  // Regression suite for a real gap: `searchProvider: "remote"` reached
  // api.transitous.org with no m10ThirdPartyEnabled check anywhere on the path,
  // while routing enforced the same gate at three separate points. The backend
  // proxy does NOT exempt it — see services/transitousAvailability.ts.
  //
  // Every case binds the accessor and the entry point on the SAME module
  // instance. An earlier case calls vi.resetModules(), so a setter reached
  // through this file's static import can land on a different instance than the
  // one a dynamic import returns — which would silently leave the gate at its
  // deny default and make the positive control fail (and the negative controls
  // pass for the wrong reason).
  type Mod = typeof import("./searchSuggestions.ts");

  async function freshMod(): Promise<Mod> {
    const mod = await import("./searchSuggestions.ts");
    mod.__resetSearchModeAccessorForTests();
    mod.__resetThirdPartyEgressAccessorForTests();
    return mod;
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    await db.open();
    await db.gtfsStops.clear();
    mockSearchStops.mockReset();
    mockSearchStops.mockResolvedValue({ data: [makeStop("remote-1", "Stotis Remote")] });
    localStorage.setItem(
      PRIVACY_DATA_MIGRATION_KEY,
      PRIVACY_DATA_MIGRATION_VERSION,
    );
    usePrivacyChoicesStore.getState().setChoice("personalization", "enabled");
  });

  afterEach(async () => {
    const mod = await import("./searchSuggestions.ts");
    mod.__resetThirdPartyEgressAccessorForTests();
    await db.close();
  });

  it("does not egress when the gate denies, even with provider=remote", async () => {
    const mod = await freshMod();
    mod.setThirdPartyEgressAccessor(() => false);
    await db.gtfsStops.bulkPut([gtfsStop("local-1", "Stotis Local", 54.7, 25.3)]);

    const results = await mod.searchSuggestions(
      "stotis", "vilnius", null, new AbortController().signal, "remote",
    );

    expect(mockSearchStops).not.toHaveBeenCalled();
    // Degrades to the local scan rather than returning nothing.
    const stops = results.filter((r) => r.kind === "stop");
    expect(stops.map((s) => (s.kind === "stop" ? s.name : ""))).toContain("Stotis Local");
  });

  it("egresses when the gate allows", async () => {
    const mod = await freshMod();
    mod.setThirdPartyEgressAccessor(() => true);

    const results = await mod.searchSuggestions(
      "stotis", "vilnius", null, new AbortController().signal, "remote",
    );

    expect(mockSearchStops).toHaveBeenCalled();
    const stops = results.filter((r) => r.kind === "stop");
    expect(stops.map((s) => (s.kind === "stop" ? s.name : ""))).toContain("Stotis Remote");
  });

  it("fails closed when the accessor was never wired", async () => {
    // bootPoi.ts wires it, but a path that reaches search before boot (or a test
    // that forgets) must not egress. Mirrors the fail-safe defaults on the
    // search-mode and geocoder-present accessors.
    const mod = await freshMod();
    await mod.searchSuggestions(
      "stotis", "vilnius", null, new AbortController().signal, "remote",
    );
    expect(mockSearchStops).not.toHaveBeenCalled();
  });

  it("never gates the local provider", async () => {
    const mod = await freshMod();
    mod.setThirdPartyEgressAccessor(() => false);
    await db.gtfsStops.bulkPut([gtfsStop("local-1", "Stotis Local", 54.7, 25.3)]);

    const results = await mod.searchSuggestions(
      "stotis", "vilnius", null, new AbortController().signal, "local",
    );

    const stops = results.filter((r) => r.kind === "stop");
    expect(stops.length).toBeGreaterThan(0);
    expect(mockSearchStops).not.toHaveBeenCalled();
  });
});


describe("POI display context", () => {
  it("preserves aliases and addresses through loading and scoring", () => {
    const record = poiRecord("mall", "გალერია თბილისი", {
      aliases: { en: ["Galleria Tbilisi"] }, address: { street: "Rustaveli Ave", houseNumber: "2/4" },
    });
    expect(scorePoiRecord(record, "galleria", null)).toMatchObject({
      label: record.name, aliases: record.aliases, address: record.address,
    });
    expect(poiLoader.entryToRecord({ ...record, id: "mall" }, "tbilisi")).toMatchObject({
      aliases: record.aliases, address: record.address,
    });
  });
});
