import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { SelfHostedGeocoderConfig } from "@pt/shared";
import { SelfHostedGeocoderAdapter } from "./SelfHostedGeocoderAdapter.ts";
import { allowFlow, denyFlow, resetFlows } from "../../test-helpers/networkDecisions.ts";
import { _resetSessionJitter } from "../coordPrivacy.ts";

const NOMINATIM_CONFIG: SelfHostedGeocoderConfig = {
  kind: "self-hosted",
  endpoint: "https://nominatim.local",
  flavor: "nominatim",
  multiTenant: true,
};

const PHOTON_CONFIG: SelfHostedGeocoderConfig = {
  kind: "self-hosted",
  endpoint: "https://photon.local",
  flavor: "photon",
  multiTenant: true,
};

const PTN_FST_CONFIG: SelfHostedGeocoderConfig = {
  kind: "self-hosted",
  endpoint: "/api/vilnius/address-search",
  flavor: "ptn-fst",
  multiTenant: false,
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetSessionJitter();
  resetFlows();
  allowFlow("operator.place-search");
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function nominatimForwardResponse() {
  return [
    {
      display_name: "Gdansk Glowny, Gdansk, Poland",
      lat: "54.3558",
      lon: "18.6466",
      importance: 0.8,
      osm_type: "node",
      osm_id: 123,
    },
  ];
}

function nominatimReverseResponse() {
  return {
    display_name: "Sopot, Pomerania, Poland",
    lat: "54.4416",
    lon: "18.5601",
    importance: 0.7,
    osm_type: "node",
    osm_id: 456,
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
          osm_type: "N",
          osm_id: 123,
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
          osm_type: "N",
          osm_id: 456,
          importance: 0.7,
        },
      },
    ],
  };
}

function ptnFstForwardResponse() {
  return {
    data: [
      {
        label: "V. Kudirkos aikštė 1",
        lat: 54.6872,
        lon: 25.2797,
        confidence: 0.9,
        matchedKey: "kudirk aikste 1",
      },
    ],
    meta: { provider: "ptn-fst", queryVariants: ["kudirk"] },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SelfHostedGeocoderAdapter", () => {
  describe("forward() URL shape", () => {
    test("Nominatim: /search?q=...&format=jsonv2&limit=5", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(NOMINATIM_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));

      await adapter.forward("Gdansk", null, new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.origin).toBe("https://nominatim.local");
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("q")).toBe("Gdansk");
      expect(url.searchParams.get("format")).toBe("jsonv2");
      expect(url.searchParams.get("limit")).toBe("5");
    });

    test("Photon: /api?q=...&limit=5", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(photonForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(PHOTON_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));

      await adapter.forward("Gdansk", null, new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.origin).toBe("https://photon.local");
      expect(url.pathname).toBe("/api");
      expect(url.searchParams.get("q")).toBe("Gdansk");
      expect(url.searchParams.get("limit")).toBe("5");
    });

    test("relative endpoint resolves against current origin", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(
        { ...NOMINATIM_CONFIG, endpoint: "/geocoder/nominatim" },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      await adapter.forward("Gdansk", null, new AbortController().signal);

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.pathname).toBe("/geocoder/nominatim/search");
      expect(url.searchParams.get("q")).toBe("Gdansk");
    });

    test("PTN FST: endpoint is the search route itself", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(ptnFstForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(PTN_FST_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));

      await adapter.forward("Кудирк", null, new AbortController().signal);

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.pathname).toBe("/api/vilnius/address-search");
      expect(url.searchParams.get("q")).toBe("Кудирк");
      expect(url.searchParams.get("limit")).toBe("5");
    });

    test("Nominatim forward with hint passes lat/lon bias", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(
        { ...NOMINATIM_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      await adapter.forward(
        "station",
        { lat: 54.35, lon: 18.64 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.searchParams.has("viewbox")).toBe(true);
    });

    test("Photon forward with hint passes lat/lon bias", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(photonForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(
        { ...PHOTON_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      await adapter.forward(
        "station",
        { lat: 54.35, lon: 18.64 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.searchParams.get("lat")).toBe("54.35");
      expect(url.searchParams.get("lon")).toBe("18.64");
    });
  });

  describe("reverse() URL shape", () => {
    test("Nominatim: /reverse?lat=...&lon=...&format=jsonv2", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimReverseResponse()));
      const adapter = new SelfHostedGeocoderAdapter(NOMINATIM_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 50,
      }));

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

    test("Photon: /reverse?lat=...&lon=...", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(photonReverseResponse()));
      const adapter = new SelfHostedGeocoderAdapter(PHOTON_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 50,
      }));

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

    test("PTN FST is forward-only", async () => {
      const adapter = new SelfHostedGeocoderAdapter(PTN_FST_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));

      const result = await adapter.reverse(
        { lat: 54.6872, lon: 25.2797 },
        new AbortController().signal,
      );

      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("privacy: isAvailable()", () => {
    test("is unavailable while the place-search decision is unset or denied", () => {
      const adapter = new SelfHostedGeocoderAdapter(NOMINATIM_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 200,
      }));
      resetFlows();
      expect(adapter.isAvailable()).toBe(false);
      denyFlow("operator.place-search");
      expect(adapter.isAvailable()).toBe(false);
    });

    test("is available once the place search is allowed, at any coarsening floor", () => {
      for (const floor of [0, 50, 100]) {
        const adapter = new SelfHostedGeocoderAdapter(NOMINATIM_CONFIG, () => ({
          m10CoarsenGridFloorMeters: floor,
          m10CoarsenGridDefaultMeters: 100,
        }));
        expect(adapter.isAvailable()).toBe(true);
      }
    });
  });

  describe("multiTenant coarsening", () => {
    test("multiTenant: true forces coarsening on reverse coords", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimReverseResponse()));
      const config: SelfHostedGeocoderConfig = {
        ...NOMINATIM_CONFIG,
        multiTenant: true,
      };
      const adapter = new SelfHostedGeocoderAdapter(config, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 50,
      }));

      await adapter.reverse(
        { lat: 54.44167, lon: 18.56017 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      const lat = parseFloat(url.searchParams.get("lat")!);
      const lon = parseFloat(url.searchParams.get("lon")!);
      expect(lat).not.toBe(54.44167);
      expect(lon).not.toBe(18.56017);
    });

    test("multiTenant: false + respect-multitenant sends raw coords", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimReverseResponse()));
      const config: SelfHostedGeocoderConfig = {
        ...NOMINATIM_CONFIG,
        multiTenant: false,
      };
      const adapter = new SelfHostedGeocoderAdapter(config, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 50,
      }));

      await adapter.reverse(
        { lat: 54.44167, lon: 18.56017 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      const lat = parseFloat(url.searchParams.get("lat")!);
      const lon = parseFloat(url.searchParams.get("lon")!);
      expect(lat).toBe(54.44167);
      expect(lon).toBe(18.56017);
    });

    test("multiTenant: false + strict coarsening floor still coarsens", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimReverseResponse()));
      const config: SelfHostedGeocoderConfig = {
        ...NOMINATIM_CONFIG,
        multiTenant: false,
      };
      const adapter = new SelfHostedGeocoderAdapter(config, () => ({
        m10CoarsenGridFloorMeters: 50,
        m10CoarsenGridDefaultMeters: 100,
      }));

      await adapter.reverse(
        { lat: 54.44167, lon: 18.56017 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      const lat = parseFloat(url.searchParams.get("lat")!);
      const lon = parseFloat(url.searchParams.get("lon")!);
      expect(lat).not.toBe(54.44167);
      expect(lon).not.toBe(18.56017);
    });
  });

  describe("fetch options", () => {
    test("requests use credentials: omit, referrerPolicy: no-referrer, cache: no-store", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(NOMINATIM_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));

      await adapter.forward("test", null, new AbortController().signal);

      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.credentials).toBe("omit");
      expect(opts.referrerPolicy).toBe("no-referrer");
      expect(opts.cache).toBe("no-store");
    });

    test("abort signal is forwarded to fetch", async () => {
      const ctrl = new AbortController();
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(NOMINATIM_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));

      await adapter.forward("test", null, ctrl.signal);

      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.signal).toBe(ctrl.signal);
    });
  });

  describe("response parsing", () => {
    test("Nominatim forward → GeocoderCandidate[]", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(NOMINATIM_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));

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
        provider: "self-hosted",
        privacyTier: "self-hosted",
      });
      expect(results[0]!.confidence).toBeGreaterThan(0);
      expect(results[0]!.confidence).toBeLessThanOrEqual(1);
    });

    test("Photon forward → GeocoderCandidate[]", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(photonForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(PHOTON_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));

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
        provider: "self-hosted",
        privacyTier: "self-hosted",
      });
    });

    test("PTN FST forward → GeocoderCandidate[]", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(ptnFstForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(PTN_FST_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));

      const results = await adapter.forward(
        "Кудирк",
        null,
        new AbortController().signal,
      );

      expect(results).toEqual([
        {
          label: "V. Kudirkos aikštė 1",
          lat: 54.6872,
          lon: 25.2797,
          confidence: 0.9,
          provider: "self-hosted",
          privacyTier: "self-hosted",
        },
      ]);
    });

    test("Nominatim reverse → GeocoderCandidate | null", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimReverseResponse()));
      const adapter = new SelfHostedGeocoderAdapter(
        { ...NOMINATIM_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      const result = await adapter.reverse(
        { lat: 54.4416, lon: 18.5601 },
        new AbortController().signal,
      );

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        label: "Sopot, Pomerania, Poland",
        lat: 54.4416,
        lon: 18.5601,
        provider: "self-hosted",
        privacyTier: "self-hosted",
      });
    });

    test("Photon reverse → GeocoderCandidate | null", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(photonReverseResponse()));
      const adapter = new SelfHostedGeocoderAdapter(
        { ...PHOTON_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      const result = await adapter.reverse(
        { lat: 54.4416, lon: 18.5601 },
        new AbortController().signal,
      );

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        label: "Sopot, Sopot, Poland",
        lat: 54.4416,
        lon: 18.5601,
        provider: "self-hosted",
        privacyTier: "self-hosted",
      });
    });

    test("empty Nominatim response → []", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));
      const adapter = new SelfHostedGeocoderAdapter(NOMINATIM_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));

      const results = await adapter.forward(
        "xyznonexistent",
        null,
        new AbortController().signal,
      );
      expect(results).toEqual([]);
    });

    test("empty Photon response → []", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ type: "FeatureCollection", features: [] }),
      );
      const adapter = new SelfHostedGeocoderAdapter(PHOTON_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));

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
      const adapter = new SelfHostedGeocoderAdapter(
        { ...NOMINATIM_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      const result = await adapter.reverse(
        { lat: 0, lon: 0 },
        new AbortController().signal,
      );
      expect(result).toBeNull();
    });
  });

  describe("forward hint coarsening", () => {
    test("multiTenant: true coarsens forward hint coordinates", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(NOMINATIM_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 50,
      }));

      await adapter.forward(
        "station",
        { lat: 54.35, lon: 18.64 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      const viewbox = url.searchParams.get("viewbox")!;
      const parts = viewbox.split(",").map(Number);
      expect(parts[1]).not.toBe(54.45);
      expect(parts[0]).not.toBe(18.54);
    });

    test("Photon forward hint coarsened with multiTenant", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(photonForwardResponse()));
      const adapter = new SelfHostedGeocoderAdapter(PHOTON_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 50,
      }));

      await adapter.forward(
        "station",
        { lat: 54.35, lon: 18.64 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      const lat = parseFloat(url.searchParams.get("lat")!);
      const lon = parseFloat(url.searchParams.get("lon")!);
      expect(lat).not.toBe(54.35);
      expect(lon).not.toBe(18.64);
    });
  });

  describe("coordinate precision", () => {
    test("coarsened coordinates have grid-appropriate decimal places", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimReverseResponse()));
      const adapter = new SelfHostedGeocoderAdapter(
        { ...NOMINATIM_CONFIG, multiTenant: true },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 500,
        }),
      );

      await adapter.reverse(
        { lat: 54.44167, lon: 18.56017 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      const latStr = url.searchParams.get("lat")!;
      const lonStr = url.searchParams.get("lon")!;
      const latDecimals = latStr.includes(".") ? latStr.split(".")[1]!.length : 0;
      const lonDecimals = lonStr.includes(".") ? lonStr.split(".")[1]!.length : 0;
      expect(latDecimals).toBeLessThanOrEqual(4);
      expect(lonDecimals).toBeLessThanOrEqual(4);
    });

    test("non-coarsened coordinates preserve full precision", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimReverseResponse()));
      const adapter = new SelfHostedGeocoderAdapter(
        { ...NOMINATIM_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      await adapter.reverse(
        { lat: 54.441670123, lon: 18.560170456 },
        new AbortController().signal,
      );

      const url = new URL(fetchSpy.mock.calls[0][0]);
      expect(url.searchParams.get("lat")).toBe("54.441670123");
      expect(url.searchParams.get("lon")).toBe("18.560170456");
    });
  });

  describe("HTTP error handling", () => {
    test("non-2xx response throws descriptive error", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      );
      const adapter = new SelfHostedGeocoderAdapter(
        { ...NOMINATIM_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      await expect(
        adapter.forward("test", null, new AbortController().signal),
      ).rejects.toThrow("Geocoder HTTP 500");
    });

    test("network error propagates from fetch", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const adapter = new SelfHostedGeocoderAdapter(
        { ...NOMINATIM_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      await expect(
        adapter.forward("test", null, new AbortController().signal),
      ).rejects.toThrow("Failed to fetch");
    });
  });

  describe("empty reverse responses", () => {
    test("Photon reverse with empty features → null", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ type: "FeatureCollection", features: [] }),
      );
      const adapter = new SelfHostedGeocoderAdapter(
        { ...PHOTON_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      const result = await adapter.reverse(
        { lat: 54.35, lon: 18.64 },
        new AbortController().signal,
      );
      expect(result).toBeNull();
    });
  });

  describe("malformed response handling", () => {
    test("Nominatim forward filters out items with invalid lat/lon", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([
          { display_name: "Valid", lat: "54.35", lon: "18.64", importance: 0.5 },
          { display_name: "Bad lat", lat: "notanumber", lon: "18.64", importance: 0.5 },
          { display_name: "Missing lon", lat: "54.35", importance: 0.5 },
        ]),
      );
      const adapter = new SelfHostedGeocoderAdapter(
        { ...NOMINATIM_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      const results = await adapter.forward("test", null, new AbortController().signal);
      expect(results).toHaveLength(1);
      expect(results[0]!.label).toBe("Valid");
    });

    test("Photon forward filters out features with missing coordinates", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [18.64, 54.35] },
              properties: { name: "Valid", importance: 0.5 },
            },
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [] },
              properties: { name: "Empty coords", importance: 0.5 },
            },
          ],
        }),
      );
      const adapter = new SelfHostedGeocoderAdapter(
        { ...PHOTON_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      const results = await adapter.forward("test", null, new AbortController().signal);
      expect(results).toHaveLength(1);
      expect(results[0]!.label).toBe("Valid");
    });

    test("Nominatim reverse returns null for invalid coordinates", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ display_name: "Bad", lat: "invalid", lon: "18.64" }),
      );
      const adapter = new SelfHostedGeocoderAdapter(
        { ...NOMINATIM_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      const result = await adapter.reverse(
        { lat: 54.35, lon: 18.64 },
        new AbortController().signal,
      );
      expect(result).toBeNull();
    });

    test("Photon reverse returns null for missing coordinates", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [] },
              properties: { name: "Bad" },
            },
          ],
        }),
      );
      const adapter = new SelfHostedGeocoderAdapter(
        { ...PHOTON_CONFIG, multiTenant: false },
        () => ({
          m10CoarsenGridFloorMeters: 0,
          m10CoarsenGridDefaultMeters: 0,
        }),
      );

      const result = await adapter.reverse(
        { lat: 54.35, lon: 18.64 },
        new AbortController().signal,
      );
      expect(result).toBeNull();
    });
  });

  describe("adapter metadata", () => {
    test("id is 'self-hosted' and privacyTier is 'self-hosted'", () => {
      const adapter = new SelfHostedGeocoderAdapter(NOMINATIM_CONFIG, () => ({
        m10CoarsenGridFloorMeters: 0,
        m10CoarsenGridDefaultMeters: 0,
      }));
      expect(adapter.id).toBe("self-hosted");
      expect(adapter.privacyTier).toBe("self-hosted");
    });
  });
});
