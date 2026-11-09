import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import type { GeocoderProviderId } from "@pt/shared";
import { coarsen, _resetSessionJitter } from "../coordPrivacy.ts";
import { db } from "../../db/index.ts";
import { __resetInstallKeyCacheForTests } from "../installKey.ts";
import { __resetDegradedModeForTests } from "../installKeyDegrade.ts";
import { dedupKey } from "./dedupKey.ts";

const PROVIDER: GeocoderProviderId = "third-party-nominatim";

describe("dedupKey", () => {
  beforeEach(async () => {
    _resetSessionJitter();
    if (!db.isOpen()) await db.open();
    await db.installKey.clear();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a 64-char lowercase hex HMAC-SHA-256 string", async () => {
    const c = coarsen({ lat: 54.35, lon: 18.65 }, 500);
    const hash = await dedupKey("gdansk glowny", c, PROVIDER);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same inputs (jitter cached within session)", async () => {
    const c1 = coarsen({ lat: 54.35, lon: 18.65 }, 500);
    const c2 = coarsen({ lat: 54.35, lon: 18.65 }, 500);
    const a = await dedupKey("gdansk glowny", c1, PROVIDER);
    const b = await dedupKey("gdansk glowny", c2, PROVIDER);
    expect(a).toBe(b);
  });

  it("changes when query changes", async () => {
    const c = coarsen({ lat: 54.35, lon: 18.65 }, 500);
    const a = await dedupKey("gdansk glowny", c, PROVIDER);
    const b = await dedupKey("gdansk wrzeszcz", c, PROVIDER);
    expect(a).not.toBe(b);
  });

  it("changes when snappedCoord changes", async () => {
    const near = coarsen({ lat: 54.35, lon: 18.65 }, 500);
    const far = coarsen({ lat: 54.50, lon: 18.80 }, 500);
    const a = await dedupKey("gdansk glowny", near, PROVIDER);
    const b = await dedupKey("gdansk glowny", far, PROVIDER);
    expect(a).not.toBe(b);
  });

  it("changes when gridMeters changes (policy level invalidates cache)", async () => {
    const fine = coarsen({ lat: 54.35, lon: 18.65 }, 500);
    const coarse = coarsen({ lat: 54.35, lon: 18.65 }, 2000);
    const a = await dedupKey("gdansk glowny", fine, PROVIDER);
    const b = await dedupKey("gdansk glowny", coarse, PROVIDER);
    expect(a).not.toBe(b);
  });

  it("changes when providerId changes", async () => {
    const c = coarsen({ lat: 54.35, lon: 18.65 }, 500);
    const a = await dedupKey("gdansk glowny", c, "third-party-nominatim");
    const b = await dedupKey("gdansk glowny", c, "third-party-mapbox");
    expect(a).not.toBe(b);
  });

  it("is not the unkeyed SHA-256 of the payload, so a guessed search cannot be confirmed", async () => {
    const c = coarsen({ lat: 54.35, lon: 18.65 }, 500);
    const payload = JSON.stringify({
      query: "test",
      lat: c.snappedCoord.lat,
      lon: c.snappedCoord.lon,
      gridMeters: c.gridMeters,
      providerId: PROVIDER,
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    const unkeyed = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const actual = await dedupKey("test", c, PROVIDER);
    expect(actual).not.toBe(unkeyed);
  });

  it("differs between installs (each has its own key)", async () => {
    const c = coarsen({ lat: 54.35, lon: 18.65 }, 500);
    const first = await dedupKey("test", c, PROVIDER);
    await db.installKey.clear();
    __resetInstallKeyCacheForTests();
    const second = await dedupKey("test", c, PROVIDER);
    expect(second).not.toBe(first);
  });

  it("disables caching when the key cannot be stored", async () => {
    vi.spyOn(db.installKey, "add").mockRejectedValue(
      Object.assign(new Error("quota"), { name: "QuotaExceededError" }),
    );
    const c = coarsen({ lat: 54.35, lon: 18.65 }, 500);
    expect(await dedupKey("test", c, PROVIDER)).toBeNull();
  });
});
