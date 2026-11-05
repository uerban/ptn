import { describe, expect, it } from "vitest";

import type { CityProfile, SelfHostedGeocoderConfig } from "./adapter.js";

function validateGeocoderConfig(
  raw: unknown,
): { ok: true; value: SelfHostedGeocoderConfig } | { ok: false; reason: string } {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "missing geocoder config" };
  }
  if (typeof raw !== "object") {
    return { ok: false, reason: "geocoder config must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== "self-hosted") {
    return { ok: false, reason: `kind must be "self-hosted", got "${String(obj.kind)}"` };
  }
  if (typeof obj.endpoint !== "string" || obj.endpoint.length === 0) {
    return { ok: false, reason: "endpoint must be a non-empty string" };
  }
  if (obj.flavor !== "nominatim" && obj.flavor !== "photon" && obj.flavor !== "ptn-fst") {
    return { ok: false, reason: `flavor must be "nominatim", "photon", or "ptn-fst", got "${String(obj.flavor)}"` };
  }
  if (typeof obj.multiTenant !== "boolean") {
    return { ok: false, reason: "multiTenant must be a boolean" };
  }
  return { ok: true, value: raw as SelfHostedGeocoderConfig };
}

describe("SelfHostedGeocoderConfig schema validation", () => {
  it("accepts valid nominatim config", () => {
    const config: SelfHostedGeocoderConfig = {
      kind: "self-hosted",
      endpoint: "http://localhost:8088",
      flavor: "nominatim",
      multiTenant: true,
    };
    const result = validateGeocoderConfig(config);
    expect(result.ok).toBe(true);
  });

  it("accepts valid photon config", () => {
    const config: SelfHostedGeocoderConfig = {
      kind: "self-hosted",
      endpoint: "http://localhost:2322",
      flavor: "photon",
      multiTenant: false,
    };
    const result = validateGeocoderConfig(config);
    expect(result.ok).toBe(true);
  });

  it("accepts valid PTN FST config", () => {
    const config: SelfHostedGeocoderConfig = {
      kind: "self-hosted",
      endpoint: "/api/vilnius/address-search",
      flavor: "ptn-fst",
      multiTenant: false,
    };
    const result = validateGeocoderConfig(config);
    expect(result.ok).toBe(true);
  });

  it("rejects missing config", () => {
    expect(validateGeocoderConfig(undefined).ok).toBe(false);
    expect(validateGeocoderConfig(null).ok).toBe(false);
  });

  it("rejects wrong kind", () => {
    const result = validateGeocoderConfig({
      kind: "third-party",
      endpoint: "http://example.com",
      flavor: "nominatim",
      multiTenant: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("kind");
  });

  it("rejects empty endpoint", () => {
    const result = validateGeocoderConfig({
      kind: "self-hosted",
      endpoint: "",
      flavor: "nominatim",
      multiTenant: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("endpoint");
  });

  it("rejects invalid flavor", () => {
    const result = validateGeocoderConfig({
      kind: "self-hosted",
      endpoint: "http://localhost:8088",
      flavor: "mapbox",
      multiTenant: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("flavor");
  });

  it("rejects non-boolean multiTenant", () => {
    const result = validateGeocoderConfig({
      kind: "self-hosted",
      endpoint: "http://localhost:8088",
      flavor: "nominatim",
      multiTenant: "yes",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("multiTenant");
  });
});

describe("CityProfile geocoder field", () => {
  it("allows CityProfile without geocoder", () => {
    const profile: CityProfile = {
      id: "test",
      name: "Test City",
      country: "XX",
      center: { lat: 0, lon: 0 },
      bbox: { minLat: -1, minLon: -1, maxLat: 1, maxLon: 1 },
      agencies: [],
      modes: [],
      gtfsFeeds: [],
      gtfsRtFeeds: [],
      landmarks: [],
      searchQueries: [],
      scenarios: [],
    };
    expect(profile.geocoder).toBeUndefined();
  });

  it("allows CityProfile with geocoder", () => {
    const profile: CityProfile = {
      id: "test",
      name: "Test City",
      country: "XX",
      center: { lat: 0, lon: 0 },
      bbox: { minLat: -1, minLon: -1, maxLat: 1, maxLon: 1 },
      agencies: [],
      modes: [],
      gtfsFeeds: [],
      gtfsRtFeeds: [],
      landmarks: [],
      searchQueries: [],
      scenarios: [],
      geocoder: {
        kind: "self-hosted",
        endpoint: "http://localhost:8088",
        flavor: "nominatim",
        multiTenant: true,
      },
    };
    expect(profile.geocoder).toBeDefined();
    expect(profile.geocoder!.kind).toBe("self-hosted");
    expect(profile.geocoder!.multiTenant).toBe(true);
  });

  it("geocoder config type allows multiTenant: true default pattern", () => {
    const profile: CityProfile = {
      id: "tricity", name: "Tricity", country: "PL",
      center: { lat: 54.35, lon: 18.65 },
      bbox: { minLat: 54.28, minLon: 18.45, maxLat: 54.54, maxLon: 18.85 },
      agencies: [], modes: [], gtfsFeeds: [], gtfsRtFeeds: [],
      landmarks: [], searchQueries: [], scenarios: [],
      geocoder: { kind: "self-hosted", endpoint: "http://localhost:8088", flavor: "nominatim", multiTenant: true },
    };
    expect(profile.geocoder).toBeDefined();
    expect(profile.geocoder!.multiTenant).toBe(true);
  });
});
