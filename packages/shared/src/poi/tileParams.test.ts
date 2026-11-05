import { describe, expect, it } from "vitest";

import {
  POI_TILE_MAX_BYTES,
  PREFETCH_EST_TILE_BYTES,
  SCHEDULE_TILE_CACHE_BUDGET_BYTES,
  SCHEDULE_TILE_EDGE_KM,
  SCHEDULE_TILE_EDGE_METERS,
  TILE_CACHE_BUDGET_BYTES,
  TILE_CACHE_LRU_N,
  TILE_EDGE_KM,
  TILE_EDGE_METERS,
  TILE_MIN_K,
  TILE_OVERLAP_RATIO,
} from "./tileParams.js";
import { MAX_SUBDIVISION_DEPTH, SUBDIVISION_ALGO_VERSION } from "./tileParams.js";

describe("POI tiling params", () => {
  it("byte-budget default is 64 KB (> measured ~58 KB loose whole-bundle)", () => {
    expect(POI_TILE_MAX_BYTES).toBe(65536);
  });
  it("PREFETCH_EST_TILE_BYTES is a positive conservative upper-bound estimate", () => {
    expect(PREFETCH_EST_TILE_BYTES).toBeGreaterThan(0);
    expect(Number.isInteger(PREFETCH_EST_TILE_BYTES)).toBe(true);
    // Placeholder upper-bound: at least the byte-budget cap (a tile never
    // exceeds its policy cap, so the cap is a safe admission estimate).
    expect(PREFETCH_EST_TILE_BYTES).toBeGreaterThanOrEqual(POI_TILE_MAX_BYTES);
  });
  it("keeps k and edge constants", () => {
    expect(TILE_MIN_K).toBe(50);
    expect(TILE_EDGE_KM).toBe(12);
  });
});

describe("tileParams sanity", () => {
  it("TILE_EDGE_KM is positive", () => {
    expect(TILE_EDGE_KM).toBeGreaterThan(0);
    expect(Number.isFinite(TILE_EDGE_KM)).toBe(true);
  });

  it("TILE_EDGE_METERS equals TILE_EDGE_KM * 1000", () => {
    expect(TILE_EDGE_METERS).toBe(12000);
  });

  it("SCHEDULE_TILE_EDGE_KM is positive and smaller than the POI tile edge", () => {
    expect(SCHEDULE_TILE_EDGE_KM).toBeGreaterThan(0);
    expect(Number.isFinite(SCHEDULE_TILE_EDGE_KM)).toBe(true);
    // The schedule axis is decoupled to keep dense transit-feed tiles under
    // MAX_COMPRESSED_TILE_BYTES while POI's k-anonymity sweep stays valid.
    expect(SCHEDULE_TILE_EDGE_KM).toBeLessThan(TILE_EDGE_KM);
  });

  it("SCHEDULE_TILE_EDGE_METERS equals SCHEDULE_TILE_EDGE_KM * 1000", () => {
    expect(SCHEDULE_TILE_EDGE_METERS).toBe(SCHEDULE_TILE_EDGE_KM * 1000);
  });

  it("TILE_OVERLAP_RATIO is within [0, 0.5]", () => {
    expect(TILE_OVERLAP_RATIO).toBeGreaterThanOrEqual(0);
    expect(TILE_OVERLAP_RATIO).toBeLessThanOrEqual(0.5);
  });

  it("TILE_MIN_K honours the k-anonymity floor (>= 50)", () => {
    expect(TILE_MIN_K).toBeGreaterThanOrEqual(50);
    expect(Number.isInteger(TILE_MIN_K)).toBe(true);
  });

  it("TILE_CACHE_LRU_N is a positive integer", () => {
    expect(TILE_CACHE_LRU_N).toBeGreaterThan(0);
    expect(Number.isInteger(TILE_CACHE_LRU_N)).toBe(true);
  });

  it("TILE_CACHE_BUDGET_BYTES is positive", () => {
    expect(TILE_CACHE_BUDGET_BYTES).toBeGreaterThan(0);
    expect(Number.isInteger(TILE_CACHE_BUDGET_BYTES)).toBe(true);
  });
});

describe("subdivision constants", () => {
  it("MAX_SUBDIVISION_DEPTH is 4 (≈375 m floor at the 6 km grid)", () => {
    expect(MAX_SUBDIVISION_DEPTH).toBe(4);
  });
  it("SUBDIVISION_ALGO_VERSION is a non-empty string (manual bump for build-image brotli drift)", () => {
    expect(typeof SUBDIVISION_ALGO_VERSION).toBe("string");
    expect(SUBDIVISION_ALGO_VERSION.length).toBeGreaterThan(0);
    expect(SUBDIVISION_ALGO_VERSION).toBe("1");
  });
});

describe("schedule-tile cache budget", () => {
  it("pins SCHEDULE_TILE_CACHE_BUDGET_BYTES at 8 × the 2 MiB leaf cap", () => {
    expect(SCHEDULE_TILE_CACHE_BUDGET_BYTES).toBe(16_777_216);
    expect(SCHEDULE_TILE_CACHE_BUDGET_BYTES).toBe(8 * 2_097_152);
  });
});
