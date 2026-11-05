import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchThirdPartyGeocoder,
  PrecisionLeakError,
  assertNoPrecisionLeak,
  formatCoord,
} from "./fetchThirdParty.ts";

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(
    new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("PrecisionLeakError", () => {
  test("is an instance of Error", () => {
    const err = new PrecisionLeakError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PrecisionLeakError");
  });
});

describe("assertNoPrecisionLeak", () => {
  test("throws on URL containing lat/lon digits past the grid floor", () => {
    const preciseUrl =
      "https://nominatim.openstreetmap.org/search?lat=54.352001&lon=18.646002";
    expect(() => assertNoPrecisionLeak(preciseUrl, null, 500)).toThrow(
      PrecisionLeakError,
    );
  });

  test("valid coarsened URL passes", () => {
    const coarseUrl =
      "https://nominatim.openstreetmap.org/search?lat=54.3521&lon=18.6460";
    expect(() => assertNoPrecisionLeak(coarseUrl, null, 500)).not.toThrow();
  });

  test("throws on POST body containing overly precise coordinates", () => {
    const safeUrl = "https://nominatim.openstreetmap.org/search";
    const preciseBody = JSON.stringify({ lat: 54.35200123, lon: 18.64600456 });
    expect(() => assertNoPrecisionLeak(safeUrl, preciseBody, 500)).toThrow(
      PrecisionLeakError,
    );
  });

  test("POST body with coarsened coordinates passes", () => {
    const safeUrl = "https://nominatim.openstreetmap.org/search";
    const coarseBody = JSON.stringify({ lat: 54.3521, lon: 18.646 });
    expect(() => assertNoPrecisionLeak(safeUrl, coarseBody, 500)).not.toThrow();
  });

  test("null body is fine", () => {
    const url = "https://nominatim.openstreetmap.org/search?q=Gdansk";
    expect(() => assertNoPrecisionLeak(url, null, 500)).not.toThrow();
  });

  test("non-coordinate numbers in URL are not flagged", () => {
    const url =
      "https://nominatim.openstreetmap.org/search?q=Gdansk&limit=5&format=jsonv2";
    expect(() => assertNoPrecisionLeak(url, null, 500)).not.toThrow();
  });

  test("throws for 100m grid with precision exceeding that grid", () => {
    const url =
      "https://example.com/search?lat=54.3520012&lon=18.6460034";
    expect(() => assertNoPrecisionLeak(url, null, 100)).toThrow(
      PrecisionLeakError,
    );
  });

  test("allows coordinates at exactly the grid precision for 100m grid", () => {
    const latStep = 100 / 111_320;
    const snappedLat = Math.round(54.352 / latStep) * latStep;
    const lonStep =
      100 / (111_320 * Math.cos((snappedLat * Math.PI) / 180));
    const snappedLon = Math.round(18.646 / lonStep) * lonStep;
    const url = `https://example.com/search?lat=${formatCoord(snappedLat, 100)}&lon=${formatCoord(snappedLon, 100)}`;
    expect(() => assertNoPrecisionLeak(url, null, 100)).not.toThrow();
  });

  test("formatCoord truncates to grid-appropriate decimal places", () => {
    const latStep = 500 / 111_320;
    const snapped = Math.round(54.352001 / latStep) * latStep;
    const formatted = formatCoord(snapped, 500);
    expect(formatted).toMatch(/^\d+\.\d{4}$/);
  });

  test("1000m grid allows very coarse coordinates", () => {
    const url = "https://example.com/search?lat=54.35&lon=18.65";
    expect(() => assertNoPrecisionLeak(url, null, 1000)).not.toThrow();
  });

  test("detects precision leak in Mapbox path-embedded coordinates", () => {
    const url =
      "https://api.mapbox.com/geocoding/v5/mapbox.places/18.64600123,54.35200456.json";
    expect(() => assertNoPrecisionLeak(url, null, 500)).toThrow(
      PrecisionLeakError,
    );
  });
});

describe("fetchThirdPartyGeocoder", () => {
  test("passes through to fetch when URL is safe", async () => {
    const url = "https://nominatim.openstreetmap.org/search?lat=54.3521&lon=18.646";
    const signal = new AbortController().signal;

    const res = await fetchThirdPartyGeocoder(url, null, 500, signal);

    expect(res).toBeInstanceOf(Response);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, opts] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect(opts.credentials).toBe("omit");
    expect(opts.referrerPolicy).toBe("no-referrer");
    expect(opts.cache).toBe("no-store");
    expect(opts.signal).toBe(signal);
  });

  test("throws PrecisionLeakError before fetching when URL leaks", async () => {
    const url =
      "https://nominatim.openstreetmap.org/search?lat=54.352001&lon=18.646002";
    const signal = new AbortController().signal;

    await expect(
      fetchThirdPartyGeocoder(url, null, 500, signal),
    ).rejects.toThrow(PrecisionLeakError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("throws PrecisionLeakError before fetching when body leaks", async () => {
    const url = "https://nominatim.openstreetmap.org/search";
    const body = JSON.stringify({ lat: 54.35200123, lon: 18.64600456 });
    const signal = new AbortController().signal;

    await expect(
      fetchThirdPartyGeocoder(url, body, 500, signal),
    ).rejects.toThrow(PrecisionLeakError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
