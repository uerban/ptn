import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { LatLon } from "@pt/shared";
import {
  ThirdPartyGeocoderAdapter,
  configFromAllowlist,
  type ThirdPartyGeocoderConfig,
} from "./ThirdPartyGeocoderAdapter.ts";
import { _resetSessionJitter, type CoarsenedRequest } from "../coordPrivacy.ts";

const NOMINATIM_CONFIG: ThirdPartyGeocoderConfig = {
  provider: "nominatim",
  endpoint: "https://nominatim.openstreetmap.org",
};

const PHOTON_CONFIG: ThirdPartyGeocoderConfig = {
  provider: "photon",
  endpoint: "https://photon.komoot.io",
};

const MAPBOX_CONFIG: ThirdPartyGeocoderConfig = {
  provider: "mapbox",
  endpoint: "https://api.mapbox.com",
  apiKey: "pk.test123",
};

const ENABLED_POLICY = () => ({
  m10ThirdPartyEnabled: true as const,
  m10CoarsenGridDefaultMeters: 500,
});

const DISABLED_POLICY = () => ({
  m10ThirdPartyEnabled: false as const,
  m10CoarsenGridDefaultMeters: 500,
});

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetSessionJitter();
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function nominatimForwardResponse() {
  return [
    {
      display_name: "Gdansk Glowny, Gdansk, Poland",
      lat: "54.3558",
      lon: "18.6466",
      importance: 0.8,
    },
  ];
}

function nominatimReverseResponse() {
  return {
    display_name: "Sopot, Pomerania, Poland",
    lat: "54.4416",
    lon: "18.5601",
    importance: 0.7,
  };
}

function photonForwardResponse() {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [18.6466, 54.3558] },
        properties: {
          name: "Gdansk Glowny",
          city: "Gdansk",
          country: "Poland",
          importance: 0.8,
        },
      },
    ],
  };
}

function photonReverseResponse() {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [18.5601, 54.4416] },
        properties: {
          name: "Sopot",
          city: "Sopot",
          country: "Poland",
          importance: 0.7,
        },
      },
    ],
  };
}

function mapboxForwardResponse() {
  return {
    type: "FeatureCollection",
    features: [
      {
        place_name: "Gdansk Glowny, Gdansk, Poland",
        center: [18.6466, 54.3558],
        relevance: 0.9,
      },
    ],
  };
}

function mapboxReverseResponse() {
  return {
    type: "FeatureCollection",
    features: [
      {
        place_name: "Sopot, Pomerania, Poland",
        center: [18.5601, 54.4416],
        relevance: 0.85,
      },
    ],
  };
}

describe("ThirdPartyGeocoderAdapter", () => {
  describe("forward() coarsening", () => {
    test("hint LatLon is coarsened before outbound URL — original precise coords absent", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );
      const preciseHint: LatLon = { lat: 54.352001, lon: 18.646002 };

      await adapter.forward("Gdansk", preciseHint, new AbortController().signal);

      const rawUrl = fetchSpy.mock.calls[0][0] as string;
      expect(rawUrl).not.toContain("54.352001");
      expect(rawUrl).not.toContain("18.646002");
      const url = new URL(rawUrl);
      expect(url.searchParams.get("viewbox")).toBeTruthy();
    });

    test("forward without hint sends no proximity/viewbox parameter", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.forward("Gdansk", null, new AbortController().signal);

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.searchParams.has("viewbox")).toBe(false);
    });

    test("reverse() also coarsens the input coordinate", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimReverseResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.reverse(
        { lat: 54.441623, lon: 18.560178 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      const lat = parseFloat(url.searchParams.get("lat")!);
      const lon = parseFloat(url.searchParams.get("lon")!);
      expect(lat).not.toBe(54.441623);
      expect(lon).not.toBe(18.560178);
    });
  });

  describe("type safety", () => {
    test("raw LatLon is not assignable to CoarsenedRequest (brand enforcement)", () => {
      const raw: LatLon = { lat: 54.352, lon: 18.646 };
      // @ts-expect-error — raw LatLon lacks the CoarsenedRequest brand
      const _bad: CoarsenedRequest = raw;
      expect(_bad).toBeDefined();
    });

    test("buildForwardUrl hint parameter rejects raw LatLon at compile time", () => {
      const raw: LatLon = { lat: 54.352, lon: 18.646 };
      const fn: (hint: CoarsenedRequest | null) => void = () => {};
      // @ts-expect-error — LatLon is not assignable to CoarsenedRequest | null
      fn(raw);
    });

    test("buildReverseUrl coarsened parameter rejects raw LatLon at compile time", () => {
      const raw: LatLon = { lat: 54.352, lon: 18.646 };
      const fn: (coarsened: CoarsenedRequest) => void = () => {};
      // @ts-expect-error — LatLon is not assignable to CoarsenedRequest
      fn(raw);
    });
  });

  describe("isAvailable()", () => {
    test("returns false when m10ThirdPartyEnabled === false", () => {
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        DISABLED_POLICY,
      );
      expect(adapter.isAvailable()).toBe(false);
    });

    test("returns true when m10ThirdPartyEnabled === true", () => {
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );
      expect(adapter.isAvailable()).toBe(true);
    });
  });

  describe("fetch options", () => {
    test("credentials: omit, referrerPolicy: no-referrer, cache: no-store", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.forward("test", null, new AbortController().signal);

      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.credentials).toBe("omit");
      expect(opts.referrerPolicy).toBe("no-referrer");
      expect(opts.cache).toBe("no-store");
    });

    test("abort signal is forwarded to fetch", async () => {
      const ctrl = new AbortController();
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.forward("test", null, ctrl.signal);

      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.signal).toBe(ctrl.signal);
    });
  });

  describe("adapter metadata", () => {
    test("Nominatim: id = third-party-nominatim, tier = third-party", () => {
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );
      expect(adapter.id).toBe("third-party-nominatim");
      expect(adapter.privacyTier).toBe("third-party");
    });

    test("Photon: id = third-party-photon, tier = third-party", () => {
      const adapter = new ThirdPartyGeocoderAdapter(
        PHOTON_CONFIG,
        ENABLED_POLICY,
      );
      expect(adapter.id).toBe("third-party-photon");
      expect(adapter.privacyTier).toBe("third-party");
    });

    test("Mapbox: id = third-party-mapbox, tier = third-party", () => {
      const adapter = new ThirdPartyGeocoderAdapter(
        MAPBOX_CONFIG,
        ENABLED_POLICY,
      );
      expect(adapter.id).toBe("third-party-mapbox");
      expect(adapter.privacyTier).toBe("third-party");
    });
  });

  describe("Nominatim URL builder", () => {
    test("forward: /search?q=...&format=jsonv2&limit=5", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.forward("Gdansk", null, new AbortController().signal);

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.origin).toBe("https://nominatim.openstreetmap.org");
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("q")).toBe("Gdansk");
      expect(url.searchParams.get("format")).toBe("jsonv2");
      expect(url.searchParams.get("limit")).toBe("5");
    });

    test("reverse: /reverse?lat=...&lon=...&format=jsonv2", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimReverseResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.reverse(
        { lat: 54.4416, lon: 18.5601 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.pathname).toBe("/reverse");
      expect(url.searchParams.get("format")).toBe("jsonv2");
      expect(url.searchParams.has("lat")).toBe(true);
      expect(url.searchParams.has("lon")).toBe(true);
    });
  });

  describe("Photon URL builder", () => {
    test("forward: /api?q=...&limit=5", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(photonForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        PHOTON_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.forward("Gdansk", null, new AbortController().signal);

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.origin).toBe("https://photon.komoot.io");
      expect(url.pathname).toBe("/api");
      expect(url.searchParams.get("q")).toBe("Gdansk");
      expect(url.searchParams.get("limit")).toBe("5");
    });

    test("forward with hint includes lat/lon params", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(photonForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        PHOTON_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.forward(
        "Gdansk",
        { lat: 54.352, lon: 18.646 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.searchParams.has("lat")).toBe(true);
      expect(url.searchParams.has("lon")).toBe(true);
    });

    test("reverse: /reverse?lat=...&lon=...", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(photonReverseResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        PHOTON_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.reverse(
        { lat: 54.4416, lon: 18.5601 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.pathname).toBe("/reverse");
      expect(url.searchParams.has("lat")).toBe(true);
      expect(url.searchParams.has("lon")).toBe(true);
      expect(url.searchParams.has("format")).toBe(false);
    });
  });

  describe("Mapbox URL builder", () => {
    test("forward: /geocoding/v5/mapbox.places/{query}.json with access_token", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(mapboxForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        MAPBOX_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.forward("Gdansk", null, new AbortController().signal);

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.origin).toBe("https://api.mapbox.com");
      expect(url.pathname).toBe("/geocoding/v5/mapbox.places/Gdansk.json");
      expect(url.searchParams.get("access_token")).toBe("pk.test123");
      expect(url.searchParams.get("limit")).toBe("5");
    });

    test("forward with hint includes proximity parameter", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(mapboxForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        MAPBOX_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.forward(
        "Gdansk",
        { lat: 54.352, lon: 18.646 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.searchParams.has("proximity")).toBe(true);
    });

    test("reverse: /geocoding/v5/mapbox.places/{lon},{lat}.json", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(mapboxReverseResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        MAPBOX_CONFIG,
        ENABLED_POLICY,
      );

      await adapter.reverse(
        { lat: 54.4416, lon: 18.5601 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.pathname).toMatch(/\/geocoding\/v5\/mapbox\.places\//);
      expect(url.pathname).toMatch(/\.json$/);
      expect(url.searchParams.get("access_token")).toBe("pk.test123");
      expect(url.searchParams.get("limit")).toBe("1");
    });
  });

  describe("response parsing", () => {
    test("Nominatim forward → GeocoderCandidate[]", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );

      const results = await adapter.forward(
        "Gdansk",
        null,
        new AbortController().signal,
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        label: "Gdansk Glowny, Gdansk, Poland",
        lat: 54.3558,
        lon: 18.6466,
        provider: "third-party-nominatim",
        privacyTier: "third-party",
      });
    });

    test("Photon forward → GeocoderCandidate[]", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(photonForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        PHOTON_CONFIG,
        ENABLED_POLICY,
      );

      const results = await adapter.forward(
        "Gdansk",
        null,
        new AbortController().signal,
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        label: "Gdansk Glowny, Gdansk, Poland",
        lat: 54.3558,
        lon: 18.6466,
        provider: "third-party-photon",
        privacyTier: "third-party",
      });
    });

    test("Mapbox forward → GeocoderCandidate[]", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(mapboxForwardResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        MAPBOX_CONFIG,
        ENABLED_POLICY,
      );

      const results = await adapter.forward(
        "Gdansk",
        null,
        new AbortController().signal,
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        label: "Gdansk Glowny, Gdansk, Poland",
        lat: 54.3558,
        lon: 18.6466,
        provider: "third-party-mapbox",
        privacyTier: "third-party",
      });
      expect(results[0]!.confidence).toBeGreaterThan(0);
      expect(results[0]!.confidence).toBeLessThanOrEqual(1);
    });

    test("Nominatim reverse → GeocoderCandidate | null", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimReverseResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );

      const result = await adapter.reverse(
        { lat: 54.4416, lon: 18.5601 },
        new AbortController().signal,
      );

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        label: "Sopot, Pomerania, Poland",
        provider: "third-party-nominatim",
        privacyTier: "third-party",
      });
    });

    test("Photon reverse → GeocoderCandidate | null", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(photonReverseResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        PHOTON_CONFIG,
        ENABLED_POLICY,
      );

      const result = await adapter.reverse(
        { lat: 54.4416, lon: 18.5601 },
        new AbortController().signal,
      );

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        label: "Sopot, Sopot, Poland",
        provider: "third-party-photon",
        privacyTier: "third-party",
      });
    });

    test("Mapbox reverse → GeocoderCandidate | null", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(mapboxReverseResponse()));
      const adapter = new ThirdPartyGeocoderAdapter(
        MAPBOX_CONFIG,
        ENABLED_POLICY,
      );

      const result = await adapter.reverse(
        { lat: 54.4416, lon: 18.5601 },
        new AbortController().signal,
      );

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        label: "Sopot, Pomerania, Poland",
        provider: "third-party-mapbox",
        privacyTier: "third-party",
      });
    });

    test("empty Nominatim forward → []", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );

      const results = await adapter.forward(
        "xyznonexistent",
        null,
        new AbortController().signal,
      );
      expect(results).toEqual([]);
    });

    test("empty Mapbox forward → []", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ type: "FeatureCollection", features: [] }),
      );
      const adapter = new ThirdPartyGeocoderAdapter(
        MAPBOX_CONFIG,
        ENABLED_POLICY,
      );

      const results = await adapter.forward(
        "xyznonexistent",
        null,
        new AbortController().signal,
      );
      expect(results).toEqual([]);
    });

    test("Nominatim reverse with error response → null", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ error: "Unable to geocode" }),
      );
      const adapter = new ThirdPartyGeocoderAdapter(
        NOMINATIM_CONFIG,
        ENABLED_POLICY,
      );

      const result = await adapter.reverse(
        { lat: 0, lon: 0 },
        new AbortController().signal,
      );
      expect(result).toBeNull();
    });
  });

  describe("per-provider config wiring (T-10)", () => {
    describe("configFromAllowlist", () => {
      test("produces config with endpoint from allowlist for nominatim", () => {
        const config = configFromAllowlist("nominatim");
        expect(config.provider).toBe("nominatim");
        expect(config.endpoint).toBe("https://nominatim.openstreetmap.org");
        expect(config.apiKey).toBeUndefined();
      });

      test("produces config with endpoint from allowlist for mapbox", () => {
        const config = configFromAllowlist("mapbox");
        expect(config.provider).toBe("mapbox");
        expect(config.endpoint).toBe("https://api.mapbox.com");
      });

      test("produces config with endpoint from allowlist for photon", () => {
        const config = configFromAllowlist("photon");
        expect(config.provider).toBe("photon");
        expect(config.endpoint).toBe("https://photon.komoot.io");
      });

      test("passes through apiKey when provided", () => {
        const config = configFromAllowlist("mapbox", "pk.testkey");
        expect(config.apiKey).toBe("pk.testkey");
      });
    });

    describe("adapter uses allowlist config", () => {
      test("adapter uses endpoint from allowlist", async () => {
        fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
        const config = configFromAllowlist("nominatim");
        const adapter = new ThirdPartyGeocoderAdapter(config, ENABLED_POLICY);

        await adapter.forward("Gdansk", null, new AbortController().signal);

        const url = new URL(fetchSpy.mock.calls[0][0]);
        expect(url.origin).toBe("https://nominatim.openstreetmap.org");
      });

      test("adapter uses API key from getApiKey callback over static config", async () => {
        fetchSpy.mockResolvedValueOnce(jsonResponse(mapboxForwardResponse()));
        const config = configFromAllowlist("mapbox", "pk.static");
        const adapter = new ThirdPartyGeocoderAdapter(
          config,
          ENABLED_POLICY,
          () => "pk.dynamic123",
        );

        await adapter.forward("Gdansk", null, new AbortController().signal);

        const url = new URL(fetchSpy.mock.calls[0][0]);
        expect(url.searchParams.get("access_token")).toBe("pk.dynamic123");
      });

      test("getApiKey defaults to config.apiKey when callback not provided", async () => {
        fetchSpy.mockResolvedValueOnce(jsonResponse(mapboxForwardResponse()));
        const config = configFromAllowlist("mapbox", "pk.fromconfig");
        const adapter = new ThirdPartyGeocoderAdapter(config, ENABLED_POLICY);

        await adapter.forward("Gdansk", null, new AbortController().signal);

        const url = new URL(fetchSpy.mock.calls[0][0]);
        expect(url.searchParams.get("access_token")).toBe("pk.fromconfig");
      });
    });

    describe("API key requirement enforcement", () => {
      test("missing API key for Mapbox (requires key) disables adapter", () => {
        const config = configFromAllowlist("mapbox");
        const adapter = new ThirdPartyGeocoderAdapter(config, ENABLED_POLICY);

        expect(adapter.isAvailable()).toBe(false);
      });

      test("Nominatim without API key is still available (no key required)", () => {
        const config = configFromAllowlist("nominatim");
        const adapter = new ThirdPartyGeocoderAdapter(config, ENABLED_POLICY);

        expect(adapter.isAvailable()).toBe(true);
      });

      test("Photon without API key is still available (no key required)", () => {
        const config = configFromAllowlist("photon");
        const adapter = new ThirdPartyGeocoderAdapter(config, ENABLED_POLICY);

        expect(adapter.isAvailable()).toBe(true);
      });

      test("Mapbox with API key provided is available", () => {
        const config = configFromAllowlist("mapbox");
        const adapter = new ThirdPartyGeocoderAdapter(
          config,
          ENABLED_POLICY,
          () => "pk.valid123",
        );

        expect(adapter.isAvailable()).toBe(true);
      });
    });

    describe("unavailableReason", () => {
      test("surfaces missing API key for key-required provider", () => {
        const config = configFromAllowlist("mapbox");
        const adapter = new ThirdPartyGeocoderAdapter(config, ENABLED_POLICY);

        expect(adapter.unavailableReason).toMatch(/requires an API key/);
        expect(adapter.unavailableReason).toMatch(/Mapbox/);
      });

      test("surfaces disabled policy reason", () => {
        const config = configFromAllowlist("nominatim");
        const adapter = new ThirdPartyGeocoderAdapter(config, DISABLED_POLICY);

        expect(adapter.unavailableReason).toMatch(/disabled/i);
      });

      test("returns null when adapter is fully available", () => {
        const config = configFromAllowlist("nominatim");
        const adapter = new ThirdPartyGeocoderAdapter(config, ENABLED_POLICY);

        expect(adapter.unavailableReason).toBeNull();
      });

      test("policy check takes precedence over API key check", () => {
        const config = configFromAllowlist("mapbox");
        const adapter = new ThirdPartyGeocoderAdapter(config, DISABLED_POLICY);

        expect(adapter.unavailableReason).toMatch(/disabled/i);
        expect(adapter.unavailableReason).not.toMatch(/API key/);
      });
    });
  });
});
