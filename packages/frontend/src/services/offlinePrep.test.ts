import { describe, it, expect, vi } from "vitest";
import {
  planOfflinePrep,
  runOfflinePrep,
  type OfflinePrepDeps,
} from "./offlinePrep.ts";

describe("planOfflinePrep", () => {
  it("warms i18n, the manifest and schedule tiles at every level", () => {
    const plan = planOfflinePrep({ level: "standard", poiMode: "eager-bundle" });
    expect(plan.steps).toEqual(["i18n", "manifest", "scheduleTiles", "poi"]);
  });

  it("asks first at Baseline, whose preset deliberately avoids extra traffic", () => {
    expect(
      planOfflinePrep({ level: "baseline", poiMode: "lazy-tile" })
        .requiresConfirmation,
    ).toBe(true);
    expect(
      planOfflinePrep({ level: "standard", poiMode: "eager-bundle" })
        .requiresConfirmation,
    ).toBe(false);
  });

  // Residency: at server-side the client is not supposed to hold a POI corpus.
  // Preparing for offline must not become a way around that.
  it("drops the POI step when the corpus lives on the server", () => {
    const plan = planOfflinePrep({ level: "strict", poiMode: "server-side" });
    expect(plan.steps).not.toContain("poi");
    expect(plan.restrictions.join(" ")).toMatch(/search/i);
  });

  it("says that real-time data cannot be warmed at Paranoid", () => {
    const plan = planOfflinePrep({ level: "paranoid", poiMode: "lazy-tile" });
    expect(plan.restrictions.join(" ")).toMatch(/real-time/i);
  });

  it("never claims to warm real-time departures — they are ephemeral", () => {
    for (const level of ["baseline", "standard", "hardened"] as const) {
      const plan = planOfflinePrep({ level, poiMode: "eager-bundle" });
      expect(plan.steps).not.toContain("rt");
    }
  });
});

function deps(over: Partial<OfflinePrepDeps> = {}): OfflinePrepDeps {
  return {
    warmI18n: vi.fn(async () => {}),
    warmManifest: vi.fn(async () => {}),
    getManifest: () => ({ manifest: {}, bundleHash: "abc" }),
    tileCoordsToWarm: vi.fn(async () => ["s1", "s2", "s3"]),
    warmTile: vi.fn(async () => 100),
    warmPoi: vi.fn(async () => {}),
    ...over,
  };
}

describe("runOfflinePrep", () => {
  it("runs every planned step and reports each one done", async () => {
    const plan = planOfflinePrep({ level: "standard", poiMode: "eager-bundle" });
    const d = deps();
    const seen: string[] = [];
    const result = await runOfflinePrep(plan, d, (p) => seen.push(p.step));

    expect(result.failed).toEqual([]);
    expect(result.tilesWarmed).toBe(3);
    expect(new Set(seen)).toEqual(
      new Set(["i18n", "manifest", "scheduleTiles", "poi"]),
    );
    expect(d.warmPoi).toHaveBeenCalled();
  });

  it("skips the POI step when the plan excluded it", async () => {
    const plan = planOfflinePrep({ level: "strict", poiMode: "server-side" });
    const d = deps();
    await runOfflinePrep(plan, d, () => {});
    expect(d.warmPoi).not.toHaveBeenCalled();
  });

  it("stops warming tiles once the byte budget is spent", async () => {
    const plan = planOfflinePrep({ level: "standard", poiMode: "eager-bundle" });
    const d = deps({
      tileCoordsToWarm: async () => ["s1", "s2", "s3", "s4", "s5"],
      warmTile: vi.fn(async () => 400),
      byteBudget: 900,
    });
    const result = await runOfflinePrep(plan, d, () => {});
    // 400 + 400 fits; the third would exceed 900, so it must not be fetched.
    expect(d.warmTile).toHaveBeenCalledTimes(2);
    expect(result.budgetExhausted).toBe(true);
  });

  it("keeps going when one step throws, and reports it", async () => {
    const plan = planOfflinePrep({ level: "standard", poiMode: "eager-bundle" });
    const d = deps({
      warmManifest: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const result = await runOfflinePrep(plan, d, () => {});
    expect(result.failed).toContain("manifest");
    // A failed manifest must not silently produce a "ready for offline" claim.
    expect(result.ok).toBe(false);
    expect(d.warmPoi).toHaveBeenCalled();
  });

  it("does not attempt tiles when the manifest never resolved", async () => {
    const plan = planOfflinePrep({ level: "standard", poiMode: "eager-bundle" });
    const d = deps({ getManifest: () => null });
    const result = await runOfflinePrep(plan, d, () => {});
    expect(d.warmTile).not.toHaveBeenCalled();
    expect(result.failed).toContain("scheduleTiles");
  });

  it("can be cancelled mid-sweep", async () => {
    const plan = planOfflinePrep({ level: "standard", poiMode: "eager-bundle" });
    const controller = new AbortController();
    const warmTile = vi.fn(async () => {
      controller.abort();
      return 10;
    });
    const d = deps({
      tileCoordsToWarm: async () => ["s1", "s2", "s3", "s4"],
      warmTile,
    });
    const result = await runOfflinePrep(plan, d, () => {}, controller.signal);
    expect(warmTile).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
  });
});
