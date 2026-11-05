import { describe, test, expect, beforeEach } from "vitest";
import type { LatLon, BaseEndpoint } from "@pt/shared";
import {
  persistMapTap,
  coarsen,
  getSessionJitter,
  _resetSessionJitter,
  _clearModuleState,
  type StoredMapPoint,
  type CoarsenedRequest,
} from "./coordPrivacy.ts";

const raw: LatLon = { lat: 54.687251, lon: 25.279734 };

function metersBetween(a: LatLon, b: LatLon): number {
  const latMeters = (a.lat - b.lat) * 111_320;
  const lonMeters =
    (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(latMeters, lonMeters);
}

describe("persistMapTap", () => {
  test("raw: unchanged", () => {
    const stored = persistMapTap(raw, "raw");
    expect(stored.lat).toBe(raw.lat);
    expect(stored.lon).toBe(raw.lon);
  });

  test("snap-centroid: unchanged", () => {
    const stored = persistMapTap(raw, "snap-centroid");
    expect(stored.lat).toBe(raw.lat);
    expect(stored.lon).toBe(raw.lon);
  });

  test("snap-rounded-50m: rounds lat/lon to 50m grid and stays within 50m of raw", () => {
    const stored = persistMapTap(raw, "snap-rounded-50m");
    const latStep = 50 / 111_320;
    const lonStep = 50 / (111_320 * Math.cos((stored.lat * Math.PI) / 180));
    const latMultiples = stored.lat / latStep;
    const lonMultiples = stored.lon / lonStep;
    expect(Math.abs(latMultiples - Math.round(latMultiples))).toBeLessThan(1e-9);
    expect(Math.abs(lonMultiples - Math.round(lonMultiples))).toBeLessThan(1e-9);
    expect(metersBetween(stored, raw)).toBeLessThanOrEqual(50);
  });

  test("snap-rounded-100m: rounds lat/lon to 100m grid and stays within ~100m of raw", () => {
    const stored = persistMapTap(raw, "snap-rounded-100m");
    const latStep = 100 / 111_320;
    const lonStep = 100 / (111_320 * Math.cos((stored.lat * Math.PI) / 180));
    const latMultiples = stored.lat / latStep;
    const lonMultiples = stored.lon / lonStep;
    expect(Math.abs(latMultiples - Math.round(latMultiples))).toBeLessThan(1e-9);
    expect(Math.abs(lonMultiples - Math.round(lonMultiples))).toBeLessThan(1e-9);
    expect(metersBetween(stored, raw)).toBeLessThanOrEqual(100);
  });

  test("snap-rounded-100m-no-reverse: rounds identically to snap-rounded-100m", () => {
    const a = persistMapTap(raw, "snap-rounded-100m");
    const b = persistMapTap(raw, "snap-rounded-100m-no-reverse");
    expect(b.lat).toBe(a.lat);
    expect(b.lon).toBe(a.lon);
  });

  test("snap-rounded-50m: two nearby taps within same cell collapse to same coord", () => {
    const a = persistMapTap(raw, "snap-rounded-50m");
    const b = persistMapTap(
      { lat: raw.lat + 0.00005, lon: raw.lon + 0.00005 },
      "snap-rounded-50m",
    );
    expect(b.lat).toBe(a.lat);
    expect(b.lon).toBe(a.lon);
  });

  test("StoredMapPoint cannot be constructed from a plain LatLon without going through persistMapTap", () => {
    // @ts-expect-error — LatLon lacks the unique brand symbol, so assignment must be rejected.
    const _bad: StoredMapPoint = raw;
    const ok: StoredMapPoint = persistMapTap(raw, "raw");
    expect(ok.lat).toBe(raw.lat);
    expect(ok.lon).toBe(raw.lon);
  });

  test("round-trip rawCoord → StoredMapPoint composes into a 'mappoint' BaseEndpoint", () => {
    const stored = persistMapTap(raw, "raw");
    const ep: BaseEndpoint = {
      kind: "mappoint",
      lat: stored.lat,
      lon: stored.lon,
    };
    expect(ep.kind).toBe("mappoint");
    expect(ep.lat).toBe(raw.lat);
    expect(ep.lon).toBe(raw.lon);
  });
});

describe("coarsen", () => {
  const gdansk: LatLon = { lat: 54.352, lon: 18.646 };

  beforeEach(() => {
    _resetSessionJitter();
  });

  test("snaps to a 500m grid cell", () => {
    const result = coarsen(gdansk, 500);
    const latStep = 500 / 111_320;
    const latMultiples = result.snappedCoord.lat / latStep;
    expect(Math.abs(latMultiples - Math.round(latMultiples))).toBeLessThan(
      1e-9,
    );
    const lonStep =
      500 /
      (111_320 *
        Math.cos((result.snappedCoord.lat * Math.PI) / 180));
    const lonMultiples = result.snappedCoord.lon / lonStep;
    expect(Math.abs(lonMultiples - Math.round(lonMultiples))).toBeLessThan(
      1e-9,
    );
  });

  test("fine precision inputs produce identical output within the same session", () => {
    const a = coarsen({ lat: 54.352001, lon: 18.646001 }, 500);
    const b = coarsen({ lat: 54.352002, lon: 18.646002 }, 500);
    expect(a.snappedCoord.lat).toBe(b.snappedCoord.lat);
    expect(a.snappedCoord.lon).toBe(b.snappedCoord.lon);
  });

  test("gridMeters field equals input", () => {
    expect(coarsen(gdansk, 500).gridMeters).toBe(500);
    expect(coarsen(gdansk, 100).gridMeters).toBe(100);
    expect(coarsen(gdansk, 1000).gridMeters).toBe(1000);
  });

  test("originalWithheld is always true", () => {
    expect(coarsen(gdansk, 500).originalWithheld).toBe(true);
    expect(coarsen(gdansk, 100).originalWithheld).toBe(true);
  });

  test("CoarsenedRequest cannot be constructed from a plain object without coarsen()", () => {
    // @ts-expect-error — plain object lacks the unique brand symbol
    const _bad: CoarsenedRequest = {
      snappedCoord: { lat: 54.352, lon: 18.646 },
      gridMeters: 500,
      originalWithheld: true as const,
    };
    const ok: CoarsenedRequest = coarsen(gdansk, 500);
    expect(ok.snappedCoord).toBeDefined();
  });
});

describe("per-session grid jitter", () => {
  const gdansk: LatLon = { lat: 54.352, lon: 18.646 };

  beforeEach(() => {
    _resetSessionJitter();
  });

  test("same raw input produces same snapped cell within a single session", () => {
    const a = coarsen(gdansk, 500);
    const b = coarsen(gdansk, 500);
    expect(a.snappedCoord.lat).toBe(b.snappedCoord.lat);
    expect(a.snappedCoord.lon).toBe(b.snappedCoord.lon);
  });

  test("same raw input produces DIFFERENT snapped cell across distinct sessions", () => {
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      _resetSessionJitter();
      const r = coarsen(gdansk, 500);
      results.add(`${r.snappedCoord.lat},${r.snappedCoord.lon}`);
    }
    expect(results.size).toBeGreaterThan(1);
  });

  test("jitter magnitude is bounded to [-gridMeters/2, +gridMeters/2]", () => {
    const EARTH_LAT_M = 111_320;
    for (let i = 0; i < 50; i++) {
      _resetSessionJitter();
      const fractions = getSessionJitter();
      for (const gridMeters of [100, 500, 1000]) {
        const latStep = gridMeters / EARTH_LAT_M;
        const jitterLatMeters = Math.abs(fractions.fLat * latStep) * EARTH_LAT_M;
        expect(jitterLatMeters).toBeLessThanOrEqual(gridMeters / 2 + 1e-9);

        const lonStep =
          gridMeters / (EARTH_LAT_M * Math.cos((54.352 * Math.PI) / 180));
        const jitterLonMeters =
          Math.abs(fractions.fLon * lonStep) *
          EARTH_LAT_M *
          Math.cos((54.352 * Math.PI) / 180);
        expect(jitterLonMeters).toBeLessThanOrEqual(gridMeters / 2 + 1e-9);
      }
    }
  });

  test("jitter fractions are in [-0.5, 0.5)", () => {
    for (let i = 0; i < 50; i++) {
      _resetSessionJitter();
      const fractions = getSessionJitter();
      expect(fractions.fLat).toBeGreaterThanOrEqual(-0.5);
      expect(fractions.fLat).toBeLessThan(0.5);
      expect(fractions.fLon).toBeGreaterThanOrEqual(-0.5);
      expect(fractions.fLon).toBeLessThan(0.5);
    }
  });

  test("jitter persists via sessionStorage nonce — same nonce returns same fractions", () => {
    const first = getSessionJitter();
    const second = getSessionJitter();
    expect(second.fLat).toBe(first.fLat);
    expect(second.fLon).toBe(first.fLon);
  });

  test("jitter fractions survive module reload (sessionStorage persists)", () => {
    const first = getSessionJitter();
    _clearModuleState();
    const second = getSessionJitter();
    expect(second.fLat).toBe(first.fLat);
    expect(second.fLon).toBe(first.fLon);
  });
});
