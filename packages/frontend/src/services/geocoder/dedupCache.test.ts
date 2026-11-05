import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import "fake-indexeddb/auto";
import type { GeocoderCandidate, GeocoderProviderId } from "@pt/shared";
import { db } from "../../db/index.ts";
import { RECORD_VERSION, decrypt } from "../cryptoBox.ts";
import {
  __resetInstallKeyCacheForTests,
  getOrCreateInstallKey,
} from "../installKey.ts";
import { __resetDegradedModeForTests } from "../installKeyDegrade.ts";
import { usePrivacyStore } from "../../stores/privacyStore.ts";
import {
  __resetDedupCacheWarningsForTests,
  DEDUP_SWEEP_INTERVAL_MS,
  readDedupEntry,
  startDedupSweep,
  stopDedupSweep,
  sweepExpired,
  ttlForDedupAxis,
  writeDedupEntry,
} from "./dedupCache.ts";

const PROVIDER: GeocoderProviderId = "third-party-nominatim";
const GRID = 500;

function makeCandidate(i: number): GeocoderCandidate {
  return {
    label: `Result ${i}`,
    lat: 54.35 + i * 0.001,
    lon: 18.65 + i * 0.001,
    confidence: 0.8 - i * 0.1,
    provider: PROVIDER,
    privacyTier: "third-party",
  };
}

describe("ttlForDedupAxis", () => {
  it("maps every axis value to the documented window", () => {
    expect(ttlForDedupAxis("plaintext-30d")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(ttlForDedupAxis("encrypted-7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(ttlForDedupAxis("encrypted-1d")).toBe(24 * 60 * 60 * 1000);
    expect(ttlForDedupAxis("disabled")).toBeNull();
  });
});

describe("dedupCache", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.geocoderDedup.clear();
    await db.installKey.clear();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    __resetDedupCacheWarningsForTests();
    usePrivacyStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("writeDedupEntry", () => {
    it("stores candidates as ciphertext with plaintext metadata", async () => {
      const candidates = [makeCandidate(0), makeCandidate(1)];
      await writeDedupEntry("hash-0001", candidates, PROVIDER, GRID, {
        now: () => 1_000,
        axis: "encrypted-7d",
      });

      const rows = await db.geocoderDedup.toArray();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.queryHash).toBe("hash-0001");
      expect(row.providerId).toBe(PROVIDER);
      expect(row.gridMeters).toBe(GRID);
      expect(row.createdAt).toBe(1_000);
      expect(row.iv.byteLength).toBe(12);
      expect(row.ct.byteLength).toBeGreaterThan(0);
      // Plaintext labels must not leak into the stored row at all.
      expect(JSON.stringify(row)).not.toContain("Result 0");
      expect(JSON.stringify(row)).not.toContain("Result 1");
    });

    it("writes ciphertext that round-trips back to the original candidates", async () => {
      const candidates = [makeCandidate(0), makeCandidate(1), makeCandidate(2)];
      await writeDedupEntry("hash-roundtrip", candidates, PROVIDER, GRID, {
        axis: "encrypted-7d",
      });
      const row = await db.geocoderDedup.get("hash-roundtrip");
      expect(row).toBeDefined();
      const key = await getOrCreateInstallKey();
      const back = (await decrypt(
        { v: RECORD_VERSION, iv: row!.iv, ct: row!.ct },
        key,
      )) as GeocoderCandidate[];
      expect(back).toEqual(candidates);
    });

    it("rejects an explicit tier other than 'encrypted'", async () => {
      const candidates = [makeCandidate(0)];
      await expect(
        writeDedupEntry("hash-reject", candidates, PROVIDER, GRID, {
          // @ts-expect-error — intentionally bypassing the type to test the guard.
          tier: "plaintext",
          axis: "encrypted-7d",
        }),
      ).rejects.toThrow(/tier.*rejected/);
      expect(await db.geocoderDedup.count()).toBe(0);
    });

    it("is a no-op when the policy axis is 'disabled'", async () => {
      await writeDedupEntry(
        "hash-disabled",
        [makeCandidate(0)],
        PROVIDER,
        GRID,
        { axis: "disabled" },
      );
      expect(await db.geocoderDedup.count()).toBe(0);
    });

    it("replaces an existing row under the same queryHash", async () => {
      await writeDedupEntry("hash-replace", [makeCandidate(0)], PROVIDER, GRID, {
        now: () => 100,
        axis: "encrypted-7d",
      });
      await writeDedupEntry("hash-replace", [makeCandidate(1)], PROVIDER, GRID, {
        now: () => 500,
        axis: "encrypted-7d",
      });
      const rows = await db.geocoderDedup.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.createdAt).toBe(500);
    });
  });

  describe("readDedupEntry", () => {
    it("returns the decrypted candidates for a fresh row", async () => {
      const candidates = [makeCandidate(0), makeCandidate(1)];
      await writeDedupEntry("hash-read", candidates, PROVIDER, GRID, {
        now: () => 1_000,
        axis: "encrypted-7d",
      });

      const back = await readDedupEntry("hash-read", {
        now: () => 1_000 + 60 * 1000,
        axis: "encrypted-7d",
      });
      expect(back).toEqual(candidates);
    });

    it("returns null for an unknown queryHash", async () => {
      const miss = await readDedupEntry("never-written", {
        axis: "encrypted-7d",
      });
      expect(miss).toBeNull();
    });

    it("returns null and deletes the row when the entry is older than the TTL", async () => {
      await writeDedupEntry("hash-expired", [makeCandidate(0)], PROVIDER, GRID, {
        now: () => 0,
        axis: "encrypted-1d",
      });
      // 2 days later — 1d TTL must evict.
      const back = await readDedupEntry("hash-expired", {
        now: () => 2 * 24 * 60 * 60 * 1000,
        axis: "encrypted-1d",
      });
      expect(back).toBeNull();
      const row = await db.geocoderDedup.get("hash-expired");
      expect(row).toBeUndefined();
    });

    it("keeps the row when it is within TTL", async () => {
      await writeDedupEntry("hash-fresh", [makeCandidate(0)], PROVIDER, GRID, {
        now: () => 0,
        axis: "encrypted-7d",
      });
      const back = await readDedupEntry("hash-fresh", {
        now: () => 3 * 24 * 60 * 60 * 1000, // within 7d
        axis: "encrypted-7d",
      });
      expect(back).not.toBeNull();
      const row = await db.geocoderDedup.get("hash-fresh");
      expect(row).toBeDefined();
    });

    it("returns null when the axis is 'disabled' even if a row exists", async () => {
      // Seed under a non-disabled axis, then read with disabled.
      await writeDedupEntry("hash-seed", [makeCandidate(0)], PROVIDER, GRID, {
        axis: "encrypted-7d",
      });
      const back = await readDedupEntry("hash-seed", { axis: "disabled" });
      expect(back).toBeNull();
      // The row is left in place — sweep handles cleanup, not reads.
      expect(await db.geocoderDedup.get("hash-seed")).toBeDefined();
    });

    it("treats a corrupted ciphertext as a miss and drops the row", async () => {
      // Seed a legitimately encrypted row, then overwrite ct with garbage.
      await writeDedupEntry("hash-bad", [makeCandidate(0)], PROVIDER, GRID, {
        axis: "encrypted-7d",
      });
      const row = await db.geocoderDedup.get("hash-bad");
      expect(row).toBeDefined();
      const corrupted = new ArrayBuffer(row!.ct.byteLength);
      new Uint8Array(corrupted).set(new Uint8Array(row!.ct.byteLength).fill(0xaa));
      await db.geocoderDedup.put({ ...row!, ct: corrupted });

      const back = await readDedupEntry("hash-bad", {
        axis: "encrypted-7d",
      });
      expect(back).toBeNull();
      expect(await db.geocoderDedup.get("hash-bad")).toBeUndefined();
    });

    it("rejects an explicit tier other than 'encrypted' on read", async () => {
      await expect(
        readDedupEntry("hash-x", {
          // @ts-expect-error — intentionally bypassing the type.
          tier: "plaintext",
          axis: "encrypted-7d",
        }),
      ).rejects.toThrow(/tier.*rejected/);
    });
  });

  describe("degraded mode (install key unavailable)", () => {
    it("write is a no-op, read returns null, and a single warning is logged", async () => {
      const cause = Object.assign(new Error("not supported"), {
        name: "NotSupportedError",
      });
      vi.spyOn(crypto.subtle, "generateKey").mockRejectedValue(cause);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await writeDedupEntry("hash-degraded", [makeCandidate(0)], PROVIDER, GRID, {
        axis: "encrypted-7d",
      });
      expect(await db.geocoderDedup.count()).toBe(0);

      // Seed a separate row bypassing writeDedupEntry so read has something
      // to attempt against (simulating a row written before the key died).
      const ivBuf = new ArrayBuffer(12);
      const ctBuf = new ArrayBuffer(16);
      await db.geocoderDedup.put({
        queryHash: "hash-preexisting",
        ct: ctBuf,
        iv: ivBuf,
        createdAt: Date.now(),
        providerId: PROVIDER,
        gridMeters: GRID,
      });
      const back = await readDedupEntry("hash-preexisting", {
        axis: "encrypted-7d",
      });
      expect(back).toBeNull();

      // Exactly one warning, even across write + read attempts.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/install key unavailable/);
    });
  });

  describe("sweepExpired", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it("removes rows older than the TTL and keeps fresher rows", async () => {
      await writeDedupEntry("old", [makeCandidate(0)], PROVIDER, GRID, {
        now: () => 0,
        axis: "encrypted-1d",
      });
      await writeDedupEntry("young", [makeCandidate(1)], PROVIDER, GRID, {
        now: () => 2 * DAY_MS,
        axis: "encrypted-1d",
      });

      // Sweep at T=2.5d with 1d TTL → cutoff is 1.5d; "old" (t=0) goes,
      // "young" (t=2d) stays.
      const deleted = await sweepExpired({
        now: () => 2.5 * DAY_MS,
        axis: "encrypted-1d",
      });
      expect(deleted).toBe(1);
      expect(await db.geocoderDedup.get("old")).toBeUndefined();
      expect(await db.geocoderDedup.get("young")).toBeDefined();
    });

    it("clears the whole table when the axis is 'disabled'", async () => {
      await writeDedupEntry("a", [makeCandidate(0)], PROVIDER, GRID, {
        axis: "encrypted-7d",
      });
      await writeDedupEntry("b", [makeCandidate(1)], PROVIDER, GRID, {
        axis: "encrypted-7d",
      });
      expect(await db.geocoderDedup.count()).toBe(2);

      const deleted = await sweepExpired({ axis: "disabled" });
      expect(deleted).toBe(2);
      expect(await db.geocoderDedup.count()).toBe(0);
    });

    it("returns 0 when no rows are expired", async () => {
      await writeDedupEntry("fresh", [makeCandidate(0)], PROVIDER, GRID, {
        now: () => 0,
        axis: "encrypted-7d",
      });
      const deleted = await sweepExpired({
        now: () => 60_000,
        axis: "encrypted-7d",
      });
      expect(deleted).toBe(0);
      expect(await db.geocoderDedup.count()).toBe(1);
    });

    it("shortens retention on axis tightening — 7d rows are purged at 1d TTL", async () => {
      await writeDedupEntry("old-standard", [makeCandidate(0)], PROVIDER, GRID, {
        now: () => 0,
        axis: "encrypted-7d",
      });
      // With 1d TTL at T=3d, the row written at t=0 is well past cutoff.
      const deleted = await sweepExpired({
        now: () => 3 * DAY_MS,
        axis: "encrypted-1d",
      });
      expect(deleted).toBe(1);
    });
  });

  describe("startDedupSweep scheduling", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    afterEach(() => {
      stopDedupSweep();
      vi.useRealTimers();
    });

    it("exports an hourly default interval", () => {
      expect(DEDUP_SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
    });

    it("runs an immediate sweep on startup", async () => {
      const now = Date.now();
      await writeDedupEntry("stale", [makeCandidate(0)], PROVIDER, GRID, {
        now: () => now - 30 * DAY_MS,
        axis: "encrypted-7d",
      });
      expect(await db.geocoderDedup.count()).toBe(1);

      const stop = startDedupSweep({ intervalMs: 60_000 });
      try {
        await vi.waitFor(async () => {
          expect(await db.geocoderDedup.count()).toBe(0);
        });
      } finally {
        stop();
      }
    });

    it("re-runs the sweep after each interval tick", async () => {
      const now = Date.now();
      const stop = startDedupSweep({ intervalMs: 30 });
      try {
        // Let the initial sweep run against the empty table, then seed a stale
        // row and confirm a later tick removes it.
        await new Promise((r) => setTimeout(r, 60));
        await writeDedupEntry(
          "later-stale",
          [makeCandidate(0)],
          PROVIDER,
          GRID,
          {
            now: () => now - 30 * DAY_MS,
            axis: "encrypted-7d",
          },
        );
        await vi.waitFor(
          async () => {
            expect(await db.geocoderDedup.count()).toBe(0);
          },
          { timeout: 2_000 },
        );
      } finally {
        stop();
      }
    });

    it("stopDedupSweep halts further ticks", async () => {
      const now = Date.now();
      startDedupSweep({ intervalMs: 30 });
      stopDedupSweep();
      await writeDedupEntry("survives", [makeCandidate(0)], PROVIDER, GRID, {
        now: () => now - 30 * DAY_MS,
        axis: "encrypted-7d",
      });
      // Give any stray timer plenty of wall time to fire.
      await new Promise((r) => setTimeout(r, 200));
      expect(await db.geocoderDedup.count()).toBe(1);
    });
  });

  describe("policy integration", () => {
    it("reads the axis from the policy store when no axis override is passed", async () => {
      // Default level = "standard" → encrypted-7d.
      await writeDedupEntry(
        "hash-policy",
        [makeCandidate(0)],
        PROVIDER,
        GRID,
      );
      expect(await db.geocoderDedup.count()).toBe(1);

      // Force disabled via an override; subsequent writes no-op and reads miss.
      usePrivacyStore.getState().setOverride("m10DedupCache", "disabled");
      await writeDedupEntry(
        "hash-policy-2",
        [makeCandidate(1)],
        PROVIDER,
        GRID,
      );
      expect(await db.geocoderDedup.get("hash-policy-2")).toBeUndefined();
      expect(
        await readDedupEntry("hash-policy"),
      ).toBeNull();
    });
  });
});
