import { describe, test, expect } from "vitest";
import {
  GEOCODER_PROVIDERS,
  getProvider,
  assertAllowlisted,
  type ThirdPartyProviderId,
} from "./geocoderProviders.ts";

describe("GEOCODER_PROVIDERS allowlist", () => {
  test("contains mapbox, nominatim, and photon entries", () => {
    const ids = Object.keys(GEOCODER_PROVIDERS);
    expect(ids).toContain("mapbox");
    expect(ids).toContain("nominatim");
    expect(ids).toContain("photon");
    expect(ids).toHaveLength(3);
  });

  test("each entry has required fields", () => {
    for (const [id, config] of Object.entries(GEOCODER_PROVIDERS)) {
      expect(config.id).toBe(id);
      expect(typeof config.name).toBe("string");
      expect(config.name.length).toBeGreaterThan(0);
      expect(typeof config.endpoint).toBe("string");
      expect(config.endpoint).toMatch(/^https:\/\//);
      expect(typeof config.tosUrl).toBe("string");
      expect(config.tosUrl).toMatch(/^https:\/\//);
      expect(typeof config.rateLimit).toBe("number");
      expect(config.rateLimit).toBeGreaterThan(0);
      expect(config.flowId).toBe("external.place-search");
      expect(config.requestFields).toEqual(["query", "coarsenedLocation"]);
      expect(Object.isFrozen(config.requestFields)).toBe(true);
    }
  });

  test("mapbox requires an API key", () => {
    expect(GEOCODER_PROVIDERS.mapbox.apiKeyFormat).toBeDefined();
    expect(typeof GEOCODER_PROVIDERS.mapbox.apiKeyFormat).toBe("string");
  });

  test("nominatim does not require an API key", () => {
    expect(GEOCODER_PROVIDERS.nominatim.apiKeyFormat).toBeUndefined();
  });

  test("photon does not require an API key", () => {
    expect(GEOCODER_PROVIDERS.photon.apiKeyFormat).toBeUndefined();
  });

  test("allowlist is frozen (immutable)", () => {
    expect(Object.isFrozen(GEOCODER_PROVIDERS)).toBe(true);
    for (const config of Object.values(GEOCODER_PROVIDERS)) {
      expect(Object.isFrozen(config)).toBe(true);
    }
  });
});

describe("getProvider", () => {
  test("returns config for a known provider", () => {
    const config = getProvider("nominatim");
    expect(config.id).toBe("nominatim");
    expect(config.name).toBe("Nominatim (OSM)");
  });

  test("returns config for all known providers", () => {
    const ids: ThirdPartyProviderId[] = ["mapbox", "nominatim", "photon"];
    for (const id of ids) {
      expect(getProvider(id).id).toBe(id);
    }
  });
});

describe("assertAllowlisted", () => {
  test("does not throw for allowlisted providers", () => {
    expect(() => assertAllowlisted("mapbox")).not.toThrow();
    expect(() => assertAllowlisted("nominatim")).not.toThrow();
    expect(() => assertAllowlisted("photon")).not.toThrow();
  });

  test("throws for non-allowlisted provider IDs", () => {
    expect(() => assertAllowlisted("google" as ThirdPartyProviderId)).toThrow(
      /not in the curated allowlist/,
    );
    expect(() =>
      assertAllowlisted("custom-server" as ThirdPartyProviderId),
    ).toThrow(/not in the curated allowlist/);
  });
});
