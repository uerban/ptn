import { describe, it, expect, beforeEach } from "vitest";
import type { GeocoderProviderId } from "@pt/shared";
import { coarsen, _resetSessionJitter } from "../coordPrivacy.ts";
import { dedupKey } from "./dedupKey.ts";

const PROVIDER: GeocoderProviderId = "third-party-nominatim";

describe("dedupKey", () => {
  beforeEach(() => {
    _resetSessionJitter();
  });

  it("returns a 64-char lowercase hex SHA-256 string", async () => {
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

  it("matches a precomputed SHA-256 of the canonical payload", async () => {
    const c = coarsen({ lat: 54.35, lon: 18.65 }, 500);
    const payload = JSON.stringify({
      query: "test",
      lat: c.snappedCoord.lat,
      lon: c.snappedCoord.lon,
      gridMeters: c.gridMeters,
      providerId: PROVIDER,
    });
    const encoded = new TextEncoder().encode(payload);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    const expected = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const actual = await dedupKey("test", c, PROVIDER);
    expect(actual).toBe(expected);
  });
});
