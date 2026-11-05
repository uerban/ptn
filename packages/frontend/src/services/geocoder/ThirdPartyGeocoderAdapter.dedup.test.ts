import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import type { LatLon } from "@pt/shared";
import {
  ThirdPartyGeocoderAdapter,
  type ThirdPartyGeocoderConfig,
} from "./ThirdPartyGeocoderAdapter.ts";
import { _resetSessionJitter } from "../coordPrivacy.ts";
import { db } from "../../db/index.ts";
import { __resetInstallKeyCacheForTests } from "../installKey.ts";
import { __resetDegradedModeForTests } from "../installKeyDegrade.ts";
import { __resetDedupCacheWarningsForTests } from "./dedupCache.ts";
import { usePrivacyStore } from "../../stores/privacyStore.ts";

const NOMINATIM_CONFIG: ThirdPartyGeocoderConfig = {
  provider: "nominatim",
  endpoint: "https://nominatim.openstreetmap.org",
};

const ENABLED_POLICY = () => ({
  m10ThirdPartyEnabled: true as const,
  m10CoarsenGridDefaultMeters: 500,
});

let fetchSpy: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function nominatimResponse(label = "Gdansk Glowny, Gdansk, Poland") {
  return [
    {
      display_name: label,
      lat: "54.3558",
      lon: "18.6466",
      importance: 0.8,
    },
  ];
}

const HINT: LatLon = { lat: 54.35, lon: 18.65 };

beforeEach(async () => {
  _resetSessionJitter();
  if (!db.isOpen()) await db.open();
  await db.geocoderDedup.clear();
  await db.installKey.clear();
  __resetInstallKeyCacheForTests();
  __resetDegradedModeForTests();
  __resetDedupCacheWarningsForTests();
  usePrivacyStore.getState().reset();

  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ThirdPartyGeocoderAdapter dedup cache", () => {
  test("first forward call fetches outbound and writes a dedup row", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimResponse()));
    const adapter = new ThirdPartyGeocoderAdapter(
      NOMINATIM_CONFIG,
      ENABLED_POLICY,
    );

    const results = await adapter.forward(
      "Gdansk",
      HINT,
      new AbortController().signal,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe("Gdansk Glowny, Gdansk, Poland");
    expect(await db.geocoderDedup.count()).toBe(1);
  });

  test("second identical forward call is a cache hit and emits no outbound request", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimResponse()));
    const adapter = new ThirdPartyGeocoderAdapter(
      NOMINATIM_CONFIG,
      ENABLED_POLICY,
    );

    const first = await adapter.forward(
      "Gdansk",
      HINT,
      new AbortController().signal,
    );
    const second = await adapter.forward(
      "Gdansk",
      HINT,
      new AbortController().signal,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  test("distinct query → different cache key → separate outbound", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimResponse("A")));
    fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimResponse("B")));
    const adapter = new ThirdPartyGeocoderAdapter(
      NOMINATIM_CONFIG,
      ENABLED_POLICY,
    );

    const a = await adapter.forward(
      "first",
      HINT,
      new AbortController().signal,
    );
    const b = await adapter.forward(
      "second",
      HINT,
      new AbortController().signal,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(a[0]!.label).toBe("A");
    expect(b[0]!.label).toBe("B");
    expect(await db.geocoderDedup.count()).toBe(2);
  });

  test("policy axis 'disabled' bypasses cache — each call fetches fresh", async () => {
    usePrivacyStore.getState().setOverride("m10DedupCache", "disabled");
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(nominatimResponse()))
      .mockResolvedValueOnce(jsonResponse(nominatimResponse()));
    const adapter = new ThirdPartyGeocoderAdapter(
      NOMINATIM_CONFIG,
      ENABLED_POLICY,
    );

    await adapter.forward("Gdansk", HINT, new AbortController().signal);
    await adapter.forward("Gdansk", HINT, new AbortController().signal);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await db.geocoderDedup.count()).toBe(0);
  });

  test("flipping axis to 'disabled' after a seeded entry makes future calls fetch", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(nominatimResponse()))
      .mockResolvedValueOnce(jsonResponse(nominatimResponse()));
    const adapter = new ThirdPartyGeocoderAdapter(
      NOMINATIM_CONFIG,
      ENABLED_POLICY,
    );

    await adapter.forward("Gdansk", HINT, new AbortController().signal);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    usePrivacyStore.getState().setOverride("m10DedupCache", "disabled");
    await adapter.forward("Gdansk", HINT, new AbortController().signal);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("adapter unavailable by policy (m10ThirdPartyEnabled=false) throws without touching cache", async () => {
    const disabledAdapter = new ThirdPartyGeocoderAdapter(
      NOMINATIM_CONFIG,
      () => ({
        m10ThirdPartyEnabled: false,
        m10CoarsenGridDefaultMeters: 500,
      }),
    );

    await expect(
      disabledAdapter.forward("Gdansk", HINT, new AbortController().signal),
    ).rejects.toThrow(/not available/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.geocoderDedup.count()).toBe(0);
  });

  test("hintless forward calls always fetch (cache requires a coarsened coord)", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(nominatimResponse()))
      .mockResolvedValueOnce(jsonResponse(nominatimResponse()));
    const adapter = new ThirdPartyGeocoderAdapter(
      NOMINATIM_CONFIG,
      ENABLED_POLICY,
    );

    await adapter.forward("Gdansk", null, new AbortController().signal);
    await adapter.forward("Gdansk", null, new AbortController().signal);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await db.geocoderDedup.count()).toBe(0);
  });

  test("non-ok response is not cached — retries hit network each time", async () => {
    const errorBody = new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
    fetchSpy
      .mockResolvedValueOnce(errorBody)
      .mockResolvedValueOnce(jsonResponse(nominatimResponse()));
    const adapter = new ThirdPartyGeocoderAdapter(
      NOMINATIM_CONFIG,
      ENABLED_POLICY,
    );

    const first = await adapter.forward(
      "Gdansk",
      HINT,
      new AbortController().signal,
    );
    expect(first).toEqual([]);
    expect(await db.geocoderDedup.count()).toBe(0);

    const second = await adapter.forward(
      "Gdansk",
      HINT,
      new AbortController().signal,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(second).toHaveLength(1);
  });

  test("cache-hit return value equals what would have been parsed from the fresh response", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(nominatimResponse()));
    const adapter = new ThirdPartyGeocoderAdapter(
      NOMINATIM_CONFIG,
      ENABLED_POLICY,
    );

    const fresh = await adapter.forward(
      "Gdansk",
      HINT,
      new AbortController().signal,
    );
    const cached = await adapter.forward(
      "Gdansk",
      HINT,
      new AbortController().signal,
    );

    expect(cached).toEqual(fresh);
    expect(cached[0]).toMatchObject({
      label: "Gdansk Glowny, Gdansk, Poland",
      provider: "third-party-nominatim",
      privacyTier: "third-party",
    });
  });
});
