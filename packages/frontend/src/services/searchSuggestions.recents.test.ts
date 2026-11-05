import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import type { ApiResponse, RecentRef, Stop } from "@pt/shared";
import { db, type PoiIndexRecord } from "../db/index.ts";

// Mock the recents source so each test seeds listRecents() directly. Spreading the
// real module keeps every other export (registerLevelChangeListener side-effect
// included — harmless) so importing the engine, which imports recents.ts, is safe.
vi.mock("./recents.ts", async (orig) => ({
  ...(await orig<typeof import("./recents.ts")>()),
  listRecents: vi.fn(),
}));
import { listRecents } from "./recents.ts";

// The engine's stops leg goes through api.ts under the "remote" provider; under
// "local" it reads db.gtfsStops directly. We use the local path (db seed) so no
// API mock is needed for the dedup case, but stub api.ts defensively anyway.
const mockSearchStops = vi.fn<(q: string, signal?: AbortSignal) => Promise<ApiResponse<Stop[]>>>();
vi.mock("./api.ts", () => ({
  api: {
    searchStops: (...args: unknown[]) =>
      mockSearchStops(args[0] as string, args[1] as AbortSignal | undefined),
  },
}));

vi.mock("./storagePolicy.ts", () => ({
  registerEvictor: vi.fn(),
  notifyWriteGrew: vi.fn().mockResolvedValue(undefined),
  onQuotaNear: vi.fn().mockResolvedValue([]),
}));

import { searchSuggestions, searchSuggestionsStream, setThirdPartyEgressAccessor } from "./searchSuggestions.ts";
import type { SearchSuggestion } from "./searchSuggestions.ts";

const sig = () => new AbortController().signal;

function gtfsStop(id: string, name: string, lat = 54.7, lon = 25.2) {
  return { id, name, lat, lon };
}

function stopRecent(stopId: string, name: string, lat = 54.7, lon = 25.2): RecentRef {
  return {
    kind: "recent",
    base: { kind: "stop", stopId, name, lat, lon },
    usedAt: Date.now(),
    usedAsOrigin: false,
  };
}

/** A GEOCODED recent (labeled place, not a stop) — surfaces via the geocoded arm
 *  with a synthetic `recent:` poiIdentity. `usedAt` defaults far enough in the
 *  past that the recency boost is well below 1.0, so a name-exact live POI (match
 *  1.0) can never be outranked — the row collapses, it does not duplicate. */
function geocodedRecent(label: string, lat = 54.7, lon = 25.2, usedAt = Date.now() - 5 * 864e5): RecentRef {
  return {
    kind: "recent",
    base: { kind: "geocoded", label, lat, lon, provider: "self-hosted", confidence: 0.9 },
    usedAt,
    usedAsOrigin: false,
  };
}

/** A POI index record that lands via a tile (so mergeLanded scores it). cityId is
 *  the BACKEND poi id for vilnius so poiCityIds("vilnius") maps to it. */
function poiRecord(id: string, name: string, lat = 54.7, lon = 25.2, overrides?: Partial<PoiIndexRecord>): PoiIndexRecord {
  return {
    id,
    cityId: "vilnius",
    name,
    geoBucket: `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`,
    aliases: {},
    category: "public_building",
    lat,
    lon,
    source: "curated" as const,
    rankBoost: 1.0,
    tier: "strict" as const,
    ...overrides,
  };
}

/** Land a tile row in the poiIndex AND hand it to onTileLanded, mirroring the
 *  bounded-merge harness in searchSuggestions.test.ts. Re-landing the SAME rows on
 *  a second tick exercises mergeLanded idempotence (no boost accumulation). */
function landDriverMulti(...batches: PoiIndexRecord[][]) {
  return async (onTileLanded: (landed?: PoiIndexRecord[]) => void | Promise<void>) => {
    for (const rows of batches) {
      await db.poiIndex.bulkPut(rows);
      await onTileLanded(rows);
    }
  };
}

function geocodedRows(emit: SearchSuggestion[]): Extract<SearchSuggestion, { kind: "geocoded" }>[] {
  return emit.filter((s): s is Extract<SearchSuggestion, { kind: "geocoded" }> => s.kind === "geocoded");
}

describe("searchSuggestionsStream — recents integration", () => {
  beforeEach(async () => {
    // Remote-provider cases here test recents merging, not the egress gate.
    setThirdPartyEgressAccessor(() => true);
    await db.open();
    await db.poiIndex.clear();
    await db.gtfsStops.clear();
    await db.stopGroups.clear();
    await db.usageStats.clear();
    vi.mocked(listRecents).mockReset();
    vi.mocked(listRecents).mockResolvedValue([]);
    mockSearchStops.mockReset();
    mockSearchStops.mockResolvedValue({ data: [] });
  });
  afterEach(async () => {
    await db.close();
  });

  it("empty query returns the recents group (a stop recent → one badged row)", async () => {
    vi.mocked(listRecents).mockResolvedValue([stopRecent("S1", "Stoties")]);

    const out = await searchSuggestions("", "vilnius", null, sig(), "local");

    expect(out).toHaveLength(1);
    const top = out[0];
    expect(top.kind).toBe("stop");
    expect(top.kind === "stop" && top.stopId).toBe("S1");
    expect(top.kind !== "stopGroup" && top.recent).toBeTruthy();
  });

  it("empty query returns [] when there are no recents", async () => {
    vi.mocked(listRecents).mockResolvedValue([]);
    const out = await searchSuggestions("", "vilnius", null, sig(), "local");
    expect(out).toEqual([]);
  });

  it("a typed query matching both a recent and a live stop of the SAME stopId yields ONE deduped row carrying .recent", async () => {
    // Live stop from local GTFS data.
    await db.gtfsStops.bulkPut([gtfsStop("S1", "Stoties")]);
    // Same stopId surfaced as a recent.
    vi.mocked(listRecents).mockResolvedValue([stopRecent("S1", "Stoties")]);

    const out = await searchSuggestions("sto", "vilnius", null, sig(), "local");

    const s1Rows = out.filter((s) => s.kind === "stop" && s.stopId === "S1");
    expect(s1Rows).toHaveLength(1); // deduped (not duplicated)
    const row = s1Rows[0];
    expect(row.kind !== "stopGroup" && row.recent).toBeTruthy(); // carries the recent marker
  });

  it("a typed query that matches no recent does not surface that recent", async () => {
    await db.gtfsStops.bulkPut([gtfsStop("S1", "Stoties")]);
    // The recent is for an unrelated place.
    vi.mocked(listRecents).mockResolvedValue([stopRecent("S9", "Antakalnio", 54.71, 25.31)]);

    const out = await searchSuggestions("sto", "vilnius", null, sig(), "local");

    // Only the live "Stoties" stop; the non-matching recent is filtered out.
    expect(out.some((s) => s.kind === "stop" && s.stopId === "S9")).toBe(false);
    expect(out.some((s) => s.kind === "stop" && s.stopId === "S1")).toBe(true);
  });

  // LAZY-TILE RE-EMIT path with a GEOCODED recent. The recent surfaces standalone
  // on the initial emit (no live POI loaded yet); a name+proximity-matching POI
  // then lands via a tile re-emit. The recent must COLLAPSE into the live POI row
  // (one geocoded row carrying `.recent`, keyed on the LIVE poiIdentity — not the
  // `recent:` synthetic), and the row's score must be STABLE across re-emit ticks
  // (no boost re-accumulation when mergeLanded re-runs). Drives the real stream via
  // the prefetch `driver` so mergeLanded actually executes (mirrors the bounded-
  // merge harness in searchSuggestions.test.ts).
  it("a geocoded recent collapses into a later tile-landed POI (one .recent row, LIVE identity)", async () => {
    // No live POI on the initial scan — only the recent matches the typed query.
    vi.mocked(listRecents).mockResolvedValue([
      geocodedRecent("Gedimino Cafe", 54.7, 25.2),
    ]);
    // The live POI lands LATER via the tile driver — same name + co-located (≤50 m).
    const landed = poiRecord("vilnius:gc", "Gedimino Cafe", 54.7, 25.2, {
      osmId: "node/gc",
      loadSource: "tile",
    });

    const emits: SearchSuggestion[][] = [];
    await searchSuggestionsStream("gedimino", "vilnius", null, sig(), "local", {
      onResults: (partial) => emits.push(partial),
      driver: landDriverMulti([landed]),
    });

    // Initial emit: the recent stands alone with the synthetic `recent:` identity.
    const firstGeocoded = geocodedRows(emits[0]);
    expect(firstGeocoded).toHaveLength(1);
    expect(firstGeocoded[0].poiIdentity.startsWith("recent:")).toBe(true);
    expect(firstGeocoded[0].recent).toBeTruthy();

    // Final emit: exactly ONE geocoded row for "Gedimino Cafe" — the recent
    // collapsed into the live POI (not duplicated), carrying `.recent`, and keyed
    // on the LIVE identity (node/gc), not the `recent:` synthetic.
    const last = geocodedRows(emits.at(-1)!);
    const gc = last.filter((s) => s.label === "Gedimino Cafe");
    expect(gc).toHaveLength(1);
    expect(gc[0].recent).toBeTruthy();
    expect(gc[0].poiIdentity).toBe("node/gc");
    expect(gc[0].poiIdentity.startsWith("recent:")).toBe(false);
  });

  it("re-emit is idempotent: a collapsed recent's score does not inflate across ticks", async () => {
    vi.mocked(listRecents).mockResolvedValue([
      geocodedRecent("Gedimino Cafe", 54.7, 25.2),
    ]);
    const landed = poiRecord("vilnius:gc", "Gedimino Cafe", 54.7, 25.2, {
      osmId: "node/gc",
      loadSource: "tile",
    });

    const emits: SearchSuggestion[][] = [];
    // TWO ticks landing the SAME row — the second tick re-runs mergeLanded over a
    // bestN that already holds the collapsed recent. If the recency boost re-applied
    // per tick, the score would climb; the merge must be idempotent.
    await searchSuggestionsStream("gedimino", "vilnius", null, sig(), "local", {
      onResults: (partial) => emits.push(partial),
      driver: landDriverMulti([landed], [landed]),
    });

    // At least: initial + tick1 + tick2 (+ terminal). Grab the row's score from the
    // FIRST post-merge emit (where it first carries `.recent` on the live identity)
    // and the LAST emit, and assert it never increased.
    const scoreOf = (emit: SearchSuggestion[]): number | undefined => {
      const row = geocodedRows(emit).find((s) => s.poiIdentity === "node/gc");
      return row?.score;
    };
    const postMerge = emits
      .map(scoreOf)
      .filter((v): v is number => v !== undefined);
    expect(postMerge.length).toBeGreaterThanOrEqual(2); // collapsed on >=2 emits
    const firstScore = postMerge[0];
    const lastScore = postMerge.at(-1)!;
    // Stable: no boost inflation / accumulation across re-emit ticks.
    expect(lastScore).toBe(firstScore);
    // And still exactly one geocoded row for the place on the final emit.
    expect(geocodedRows(emits.at(-1)!).filter((s) => s.label === "Gedimino Cafe")).toHaveLength(1);
  });
});
