import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import "fake-indexeddb/auto";
import type { BaseEndpoint, RecentRef } from "@pt/shared";
import { db, type RecentLocationRecord } from "../db/index.ts";
import {
  MAX_RECENTS,
  endpointFingerprint,
  recordRecent,
  readRamRecent,
  tierForRecentsAxis,
  ttlForRecentsAxis,
  sweepRecents,
  startRecentsSweep,
  stopRecentsSweep,
  clearRecents,
  migrateRecentsForLevelChange,
  RECENTS_SWEEP_INTERVAL_MS,
  __clearRamRecentsForTests,
  __getRamRecentsForTests,
  listRecents,
  countRecents,
  __resetRecentsCacheForTests,
} from "./recents.ts";
import type { EncryptedRecord } from "./cryptoBox.ts";
import {
  __clearRamStoreForTests,
  decrypt,
  listRamRecords,
} from "./cryptoBox.ts";
import {
  getOrCreateInstallKey,
  __resetInstallKeyCacheForTests,
} from "./installKey.ts";
import { __resetDegradedModeForTests } from "./installKeyDegrade.ts";
import { getPolicy, usePrivacyStore } from "../stores/privacyStore.ts";
import { usePrivacyChoicesStore } from "../stores/privacyChoicesStore.ts";
import {
  PRIVACY_DATA_MIGRATION_KEY,
  PRIVACY_DATA_MIGRATION_VERSION,
} from "./privacyDataMigrationState.ts";

beforeEach(() => {
  localStorage.setItem(
    PRIVACY_DATA_MIGRATION_KEY,
    PRIVACY_DATA_MIGRATION_VERSION,
  );
  usePrivacyChoicesStore.getState().setChoice("recents", "enabled");
});

const stopEndpoint: BaseEndpoint = {
  kind: "stop",
  stopId: "S1",
  name: "Central",
  lat: 54.35,
  lon: 18.65,
};

const geocodedEndpoint: BaseEndpoint = {
  kind: "geocoded",
  lat: 54.4,
  lon: 18.6,
  label: "Długa 21",
  provider: "third-party-nominatim",
  confidence: 0.9,
};

const mapPointEndpoint: BaseEndpoint = {
  kind: "mappoint",
  lat: 54.5,
  lon: 18.7,
};

function stopN(n: number): BaseEndpoint {
  return {
    kind: "stop",
    stopId: `S${n}`,
    name: `Stop ${n}`,
    lat: 54 + n * 0.001,
    lon: 18 + n * 0.001,
  };
}

describe("tierForRecentsAxis", () => {
  it("maps plaintext → plaintext", () => {
    expect(tierForRecentsAxis("plaintext")).toBe("plaintext");
  });

  it("collapses every encrypted variant to encrypted", () => {
    expect(tierForRecentsAxis("encrypted")).toBe("encrypted");
    expect(tierForRecentsAxis("encrypted-30d")).toBe("encrypted");
    expect(tierForRecentsAxis("encrypted-7d")).toBe("encrypted");
  });

  it("maps ram-only → ram-only", () => {
    expect(tierForRecentsAxis("ram-only")).toBe("ram-only");
  });
});

describe("endpointFingerprint", () => {
  it("yields the same id for identical endpoints", () => {
    expect(endpointFingerprint(stopEndpoint)).toBe(
      endpointFingerprint({ ...stopEndpoint }),
    );
  });

  it("differentiates by kind + identity", () => {
    expect(endpointFingerprint(stopEndpoint)).not.toBe(
      endpointFingerprint(mapPointEndpoint),
    );
    expect(endpointFingerprint(stopEndpoint)).not.toBe(
      endpointFingerprint(geocodedEndpoint),
    );
    expect(endpointFingerprint(stopEndpoint)).not.toBe(
      endpointFingerprint({
        kind: "stopGroup", stopIds: ["a", "b"], lat: 0, lon: 0, label: "Group",
      }),
    );
  });

  it("endpointFingerprint is stable & sibling-order-independent for a stopGroup", () => {
    const a = endpointFingerprint({
      kind: "stopGroup", stopIds: ["b", "a"], lat: 1, lon: 2, label: "Twin",
    });
    const b = endpointFingerprint({
      kind: "stopGroup", stopIds: ["a", "b"], lat: 9, lon: 9, label: "Different coords/label, same members",
    });
    expect(a).toBe("group:a,b");
    expect(b).toBe(a); // member-set identity, not coord/label
  });
});

describe("recordRecent", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.recentLocations.clear();
    await db.installKey.clear();
    __clearRamRecentsForTests();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    usePrivacyStore.getState().reset();
  });

  afterEach(async () => {
    __clearRamRecentsForTests();
  });

  it("writes a plaintext endpoint at plaintext tier", async () => {
    await recordRecent(stopEndpoint, {
      usedAsOrigin: true,
      now: () => 1_000,
      tier: "plaintext",
    });
    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(endpointFingerprint(stopEndpoint));
    expect(row.usedAt).toBe(1_000);
    expect(row.usedAsOrigin).toBe(true);
    expect(row.endpoint).toEqual(stopEndpoint);
  });

  it("writes nothing while the recents choice is unset", async () => {
    usePrivacyChoicesStore.getState().setChoice("recents", "unset");
    await recordRecent(stopEndpoint, {
      usedAsOrigin: true,
      now: () => 1_000,
      tier: "plaintext",
    });
    expect(await db.recentLocations.count()).toBe(0);
    expect(__getRamRecentsForTests().size).toBe(0);
  });

  it("writes an EncryptedRecord at encrypted tier and keeps metadata plaintext", async () => {
    // Use a stop endpoint so the plaintext-id fingerprint carries no PII
    // we might accidentally match on; only the ciphertext should hold the
    // endpoint's mutable fields.
    await recordRecent(stopEndpoint, {
      usedAsOrigin: false,
      now: () => 2_000,
      tier: "encrypted",
    });
    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.usedAt).toBe(2_000);
    expect(row.usedAsOrigin).toBe(false);
    // The stop's display name lives inside the BaseEndpoint payload; it must
    // not appear in the stored shape.
    expect(JSON.stringify(row)).not.toContain("Central");
    // The stored endpoint must have EncryptedRecord shape.
    const stored = row.endpoint as EncryptedRecord;
    expect(stored.iv.byteLength).toBe(12);
    expect(stored.ct.byteLength).toBeGreaterThan(0);
    // Round-trip decrypt back to the original endpoint.
    const key = await getOrCreateInstallKey();
    const back = (await decrypt(stored, key)) as BaseEndpoint;
    expect(back).toEqual(stopEndpoint);
  });

  it("RAM-only tier writes to in-memory map and skips IndexedDB", async () => {
    await recordRecent(stopEndpoint, {
      usedAsOrigin: true,
      now: () => 3_000,
      tier: "ram-only",
    });
    const dbRows = await db.recentLocations.toArray();
    expect(dbRows).toHaveLength(0);

    const ram = __getRamRecentsForTests();
    expect(ram.size).toBe(1);
    const stored = ram.get(endpointFingerprint(stopEndpoint));
    expect(stored).toEqual({
      id: endpointFingerprint(stopEndpoint),
      endpoint: stopEndpoint,
      usedAt: 3_000,
      usedAsOrigin: true,
    });
  });

  it("dedupes by endpoint fingerprint and refreshes usedAt", async () => {
    await recordRecent(stopEndpoint, {
      usedAsOrigin: true,
      now: () => 100,
      tier: "plaintext",
    });
    await recordRecent(stopEndpoint, {
      usedAsOrigin: false,
      now: () => 500,
      tier: "plaintext",
    });
    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usedAt).toBe(500);
    expect(rows[0]!.usedAsOrigin).toBe(false);
  });

  it("evicts the oldest row by usedAt when inserts exceed the LRU cap", async () => {
    // Fill the cap.
    for (let i = 0; i < MAX_RECENTS; i++) {
      await recordRecent(stopN(i), {
        usedAsOrigin: false,
        now: () => i + 1, // 1..50
        tier: "plaintext",
      });
    }
    expect(await db.recentLocations.count()).toBe(MAX_RECENTS);

    // Insert one more; oldest (usedAt=1, id S0) must be evicted.
    await recordRecent(stopN(MAX_RECENTS), {
      usedAsOrigin: false,
      now: () => 1000,
      tier: "plaintext",
    });
    expect(await db.recentLocations.count()).toBe(MAX_RECENTS);
    const oldest = await db.recentLocations.get(endpointFingerprint(stopN(0)));
    expect(oldest).toBeUndefined();
    const newest = await db.recentLocations.get(
      endpointFingerprint(stopN(MAX_RECENTS)),
    );
    expect(newest).toBeDefined();
  });

  it("LRU eviction respects usedAt ordering, not insert order", async () => {
    // Insert MAX in reverse-usedAt order: latest insert has oldest usedAt.
    for (let i = 0; i < MAX_RECENTS; i++) {
      await recordRecent(stopN(i), {
        usedAsOrigin: false,
        now: () => MAX_RECENTS - i, // 50,49,…,1
        tier: "plaintext",
      });
    }
    // One more insert — oldest usedAt (1) belongs to the LAST inserted
    // (stopN(MAX_RECENTS-1)); that id must be evicted.
    await recordRecent(stopN(MAX_RECENTS + 5), {
      usedAsOrigin: false,
      now: () => 10_000,
      tier: "plaintext",
    });
    const survivors = await db.recentLocations.toArray();
    expect(survivors).toHaveLength(MAX_RECENTS);
    const evicted = await db.recentLocations.get(
      endpointFingerprint(stopN(MAX_RECENTS - 1)),
    );
    expect(evicted).toBeUndefined();
  });

  it("RAM-only tier enforces its own LRU cap independently of the table", async () => {
    for (let i = 0; i < MAX_RECENTS + 3; i++) {
      await recordRecent(stopN(i), {
        usedAsOrigin: false,
        now: () => i + 1,
        tier: "ram-only",
      });
    }
    expect(await db.recentLocations.count()).toBe(0);
    const ram = __getRamRecentsForTests();
    expect(ram.size).toBe(MAX_RECENTS);
    // The 3 oldest (S0, S1, S2) should be gone.
    for (let i = 0; i < 3; i++) {
      expect(ram.has(endpointFingerprint(stopN(i)))).toBe(false);
    }
    // The 3 freshest should still be there.
    for (let i = MAX_RECENTS; i < MAX_RECENTS + 3; i++) {
      expect(ram.has(endpointFingerprint(stopN(i)))).toBe(true);
    }
  });

  it("derives tier from the current policy when no tier override is provided", async () => {
    // Standard level → recentsEncryption: "encrypted".
    await usePrivacyStore.getState().setLevel("standard");
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 1 });
    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(1);
    const stored = rows[0]!.endpoint as EncryptedRecord;
    expect(stored.iv).toBeDefined();
    expect(stored.ct).toBeDefined();
  });

  it("derives RAM-only tier at paranoid policy", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 1 });
    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(0);
    expect(__getRamRecentsForTests().size).toBe(1);
  });

  it("Paranoid recents are routed through cryptoBox ram-only tier", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 10 });
    // The record must be discoverable via cryptoBox's shared ram store,
    // not via a recents-local collection.
    const cryptoBoxEntries = listRamRecords<RecentLocationRecord>(
      db.recentLocations,
    );
    expect(cryptoBoxEntries).toHaveLength(1);
    expect(cryptoBoxEntries[0]).toEqual({
      id: endpointFingerprint(stopEndpoint),
      endpoint: stopEndpoint,
      usedAt: 10,
      usedAsOrigin: true,
    });
    // readRamRecent round-trips the same record via cryptoBox.readRecord.
    const round = await readRamRecent(endpointFingerprint(stopEndpoint));
    expect(round).toEqual(cryptoBoxEntries[0]);
  });

  it("Paranoid recents are dropped on page reload", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 1 });
    await recordRecent(geocodedEndpoint, {
      usedAsOrigin: false,
      now: () => 2,
    });
    expect(__getRamRecentsForTests().size).toBe(2);
    expect(await db.recentLocations.count()).toBe(0);

    // Simulate a page reload: the module-scoped RAM store is re-initialized
    // empty on reload. Clearing cryptoBox's store mirrors that re-init.
    __clearRamStoreForTests();

    expect(__getRamRecentsForTests().size).toBe(0);
    expect(
      await readRamRecent(endpointFingerprint(stopEndpoint)),
    ).toBeNull();
    expect(await db.recentLocations.count()).toBe(0);
  });

  it("derives plaintext tier at baseline policy", async () => {
    await usePrivacyStore.getState().setLevel("baseline");
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 1 });
    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(1);
    const row = rows[0] as RecentLocationRecord;
    expect(row.endpoint).toEqual(stopEndpoint);
  });
});

describe("ttlForRecentsAxis", () => {
  it("encrypted-30d → 30 days", () => {
    expect(ttlForRecentsAxis("encrypted-30d")).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
  });
  it("encrypted-7d → 7 days", () => {
    expect(ttlForRecentsAxis("encrypted-7d")).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it("axes without TTL → null", () => {
    expect(ttlForRecentsAxis("plaintext")).toBeNull();
    expect(ttlForRecentsAxis("encrypted")).toBeNull();
    expect(ttlForRecentsAxis("ram-only")).toBeNull();
  });
});

describe("sweepRecents", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.recentLocations.clear();
    await db.installKey.clear();
    __clearRamRecentsForTests();
    usePrivacyStore.getState().reset();
  });

  afterEach(() => {
    stopRecentsSweep();
    __clearRamRecentsForTests();
  });

  async function seed(rows: ReadonlyArray<{ id: string; usedAt: number }>) {
    await db.recentLocations.bulkPut(
      rows.map((r) => ({
        id: r.id,
        endpoint: stopEndpoint,
        usedAt: r.usedAt,
        usedAsOrigin: false,
      })),
    );
  }

  it("removes rows older than 30d at Hardened and keeps fresh ones", async () => {
    const now = 100 * DAY_MS;
    await seed([
      { id: "stale-a", usedAt: now - 31 * DAY_MS },
      { id: "stale-b", usedAt: now - 90 * DAY_MS },
      { id: "edge", usedAt: now - 30 * DAY_MS + 1 },
      { id: "fresh", usedAt: now - 1 * DAY_MS },
    ]);
    await usePrivacyStore.getState().setLevel("hardened");
    const removed = await sweepRecents({ now: () => now });
    expect(removed).toBe(2);
    const remaining = (await db.recentLocations.toArray()).map((r) => r.id);
    expect(remaining.sort()).toEqual(["edge", "fresh"]);
  });

  it("removes rows older than 7d at Strict", async () => {
    const now = 100 * DAY_MS;
    await seed([
      { id: "stale", usedAt: now - 8 * DAY_MS },
      { id: "fresh", usedAt: now - 1 * DAY_MS },
    ]);
    await usePrivacyStore.getState().setLevel("strict");
    const removed = await sweepRecents({ now: () => now });
    expect(removed).toBe(1);
    const remaining = (await db.recentLocations.toArray()).map((r) => r.id);
    expect(remaining).toEqual(["fresh"]);
  });

  it("is a no-op at Standard (no TTL)", async () => {
    const now = 100 * DAY_MS;
    await seed([
      { id: "ancient", usedAt: now - 365 * DAY_MS },
      { id: "fresh", usedAt: now - 1 * DAY_MS },
    ]);
    await usePrivacyStore.getState().setLevel("standard");
    const removed = await sweepRecents({ now: () => now });
    expect(removed).toBe(0);
    expect(await db.recentLocations.count()).toBe(2);
  });

  it("is a no-op at Baseline (plaintext)", async () => {
    const now = 100 * DAY_MS;
    await seed([{ id: "ancient", usedAt: now - 365 * DAY_MS }]);
    await usePrivacyStore.getState().setLevel("baseline");
    const removed = await sweepRecents({ now: () => now });
    expect(removed).toBe(0);
    expect(await db.recentLocations.count()).toBe(1);
  });

  it("is a no-op at Paranoid (ram-only, no persisted rows touched)", async () => {
    const now = 100 * DAY_MS;
    // Bypass the level-change migration listener — this test isolates
    // sweepRecents and intentionally leaves a stray persisted row in place
    // while the policy reads as paranoid.
    usePrivacyStore.setState({ level: "paranoid" });
    await seed([{ id: "stray", usedAt: now - 365 * DAY_MS }]);
    const removed = await sweepRecents({ now: () => now });
    expect(removed).toBe(0);
    expect(await db.recentLocations.count()).toBe(1);
  });

  it("accepts an explicit axis override", async () => {
    const now = 100 * DAY_MS;
    await seed([{ id: "stale", usedAt: now - 10 * DAY_MS }]);
    await usePrivacyStore.getState().setLevel("standard");
    const removed = await sweepRecents({
      now: () => now,
      axis: "encrypted-7d",
    });
    expect(removed).toBe(1);
  });

  it("invalidates the listRecents cache so swept rows are not returned from a hot cache", async () => {
    const DAY_8_MS = 8 * DAY_MS;
    await usePrivacyStore.getState().setLevel("strict"); // encrypted-7d → 7d TTL
    // Record a recent at epoch (far in the past relative to the sweep time)
    await recordRecent(stopEndpoint, {
      usedAsOrigin: false,
      now: () => 0,
      tier: "plaintext",
    });
    // Warm the cache
    const cached = await listRecents();
    expect(cached).toHaveLength(1);
    // Sweep at 8 days past epoch — the row is older than the 7d TTL
    const removed = await sweepRecents({ now: () => DAY_8_MS });
    expect(removed).toBe(1);
    // Cache must be invalidated: listRecents should return []
    const afterSweep = await listRecents();
    expect(afterSweep).toHaveLength(0);
  });
});

describe("clearRecents", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.recentLocations.clear();
    await db.installKey.clear();
    __clearRamRecentsForTests();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    usePrivacyStore.getState().reset();
  });

  afterEach(() => {
    __clearRamRecentsForTests();
  });

  it("drops every persisted row and every RAM-only entry", async () => {
    await recordRecent(stopEndpoint, {
      usedAsOrigin: true,
      now: () => 1,
      tier: "plaintext",
    });
    await recordRecent(geocodedEndpoint, {
      usedAsOrigin: false,
      now: () => 2,
      tier: "encrypted",
    });
    await recordRecent(mapPointEndpoint, {
      usedAsOrigin: false,
      now: () => 3,
      tier: "ram-only",
    });
    expect(await db.recentLocations.count()).toBe(2);
    expect(__getRamRecentsForTests().size).toBe(1);

    await clearRecents();

    expect(await db.recentLocations.count()).toBe(0);
    expect(__getRamRecentsForTests().size).toBe(0);
  });

  it("is a no-op when there are no recents", async () => {
    await expect(clearRecents()).resolves.toBeUndefined();
    expect(await db.recentLocations.count()).toBe(0);
    expect(__getRamRecentsForTests().size).toBe(0);
  });
});

describe("startRecentsSweep scheduling", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.recentLocations.clear();
    __clearRamRecentsForTests();
    usePrivacyStore.getState().reset();
  });

  afterEach(() => {
    stopRecentsSweep();
    vi.useRealTimers();
    __clearRamRecentsForTests();
  });

  it("exports an hourly default interval", () => {
    expect(RECENTS_SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it("runs an immediate sweep on startup", async () => {
    // Stale rows use a past `usedAt` relative to real `Date.now()` so the
    // default 7-day TTL at Strict trips without needing fake timers (which
    // break IndexedDB's microtask scheduling).
    const now = Date.now();
    await db.recentLocations.bulkPut([
      {
        id: "stale",
        endpoint: stopEndpoint,
        usedAt: now - 20 * DAY_MS,
        usedAsOrigin: false,
      },
    ]);
    await usePrivacyStore.getState().setLevel("strict");
    const stop = startRecentsSweep({ intervalMs: 60_000 });
    try {
      await vi.waitFor(async () => {
        expect(await db.recentLocations.count()).toBe(0);
      });
    } finally {
      stop();
    }
  });

  it("re-runs the sweep after each interval tick", async () => {
    const now = Date.now();
    await usePrivacyStore.getState().setLevel("strict");
    const stop = startRecentsSweep({ intervalMs: 30 });
    try {
      // Let the initial sweep run against the empty table, then seed a stale
      // row and confirm a later tick removes it.
      await new Promise((r) => setTimeout(r, 60));
      await db.recentLocations.bulkPut([
        {
          id: "later-stale",
          endpoint: stopEndpoint,
          usedAt: now - 30 * DAY_MS,
          usedAsOrigin: false,
        },
      ]);
      await vi.waitFor(
        async () => {
          expect(await db.recentLocations.count()).toBe(0);
        },
        { timeout: 2_000 },
      );
    } finally {
      stop();
    }
  });

  it("stopRecentsSweep halts further ticks", async () => {
    const now = Date.now();
    await usePrivacyStore.getState().setLevel("strict");
    startRecentsSweep({ intervalMs: 30 });
    stopRecentsSweep();
    await db.recentLocations.bulkPut([
      {
        id: "survives",
        endpoint: stopEndpoint,
        usedAt: now - 30 * DAY_MS,
        usedAsOrigin: false,
      },
    ]);
    // Give any stray timer plenty of wall time to fire.
    await new Promise((r) => setTimeout(r, 200));
    expect(await db.recentLocations.count()).toBe(1);
  });
});

describe("recordRecent — off axis", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.recentLocations.clear();
    await db.installKey.clear();
    __clearRamRecentsForTests();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    usePrivacyStore.getState().reset();
  });

  afterEach(async () => {
    usePrivacyStore.getState().clearOverride("recentsEncryption");
    __clearRamRecentsForTests();
  });

  it("records nothing when the axis is off", async () => {
    usePrivacyStore.getState().setOverride("recentsEncryption", "off");
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 1 });
    expect(await db.recentLocations.count()).toBe(0);
    expect(__getRamRecentsForTests().size).toBe(0);
  });

  it("tierForRecentsAxis maps off to ram-only defensively", () => {
    expect(tierForRecentsAxis("off")).toBe("ram-only");
  });
});

describe("migrateRecentsForLevelChange", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.recentLocations.clear();
    await db.installKey.clear();
    __clearRamRecentsForTests();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    usePrivacyStore.getState().reset();
  });

  afterEach(() => {
    __clearRamRecentsForTests();
    __clearRamStoreForTests();
  });

  it("Baseline → Hardened encrypts existing plaintext recents at the new tier", async () => {
    // Seed a plaintext recent at Baseline.
    usePrivacyStore.setState({ level: "baseline" });
    await recordRecent(stopEndpoint, {
      usedAsOrigin: true,
      now: () => 100,
    });
    await recordRecent(geocodedEndpoint, {
      usedAsOrigin: false,
      now: () => 200,
    });
    const plaintextRows = await db.recentLocations.toArray();
    expect(plaintextRows).toHaveLength(2);
    expect(plaintextRows.every((r) => !("ct" in (r.endpoint as object)))).toBe(
      true,
    );

    await migrateRecentsForLevelChange("baseline", "hardened");

    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(2);
    const key = await getOrCreateInstallKey();
    for (const row of rows) {
      const enc = row.endpoint as EncryptedRecord;
      expect(enc.iv).toBeDefined();
      expect(enc.ct).toBeDefined();
      // Decryptable round-trip back to a BaseEndpoint.
      const back = (await decrypt(enc, key)) as BaseEndpoint;
      expect(["stop", "geocoded"]).toContain(back.kind);
    }
    // Metadata preserved.
    expect(rows.map((r) => r.usedAt).sort()).toEqual([100, 200]);
  });

  it("Hardened → Paranoid moves persisted recents into RAM and drops the persisted copy", async () => {
    usePrivacyStore.setState({ level: "hardened" });
    await recordRecent(stopEndpoint, {
      usedAsOrigin: true,
      now: () => 1_000,
    });
    expect(await db.recentLocations.count()).toBe(1);
    expect(__getRamRecentsForTests().size).toBe(0);

    await migrateRecentsForLevelChange("hardened", "paranoid");

    expect(await db.recentLocations.count()).toBe(0);
    const ram = __getRamRecentsForTests();
    expect(ram.size).toBe(1);
    const moved = ram.get(endpointFingerprint(stopEndpoint));
    expect(moved).toEqual({
      id: endpointFingerprint(stopEndpoint),
      endpoint: stopEndpoint,
      usedAt: 1_000,
      usedAsOrigin: true,
    });
  });

  it("Paranoid → Standard persists what was in RAM at the new (encrypted) tier and clears RAM", async () => {
    usePrivacyStore.setState({ level: "paranoid" });
    await recordRecent(stopEndpoint, {
      usedAsOrigin: false,
      now: () => 5_000,
    });
    expect(__getRamRecentsForTests().size).toBe(1);
    expect(await db.recentLocations.count()).toBe(0);

    await migrateRecentsForLevelChange("paranoid", "standard");

    expect(__getRamRecentsForTests().size).toBe(0);
    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(1);
    const enc = rows[0]!.endpoint as EncryptedRecord;
    expect(enc.iv.byteLength).toBe(12);
    const key = await getOrCreateInstallKey();
    const back = (await decrypt(enc, key)) as BaseEndpoint;
    expect(back).toEqual(stopEndpoint);
  });

  it("Standard → Hardened is a no-op when both axes collapse onto the encrypted tier", async () => {
    usePrivacyStore.setState({ level: "standard" });
    await recordRecent(stopEndpoint, {
      usedAsOrigin: true,
      now: () => 1,
    });
    const before = await db.recentLocations.toArray();

    await migrateRecentsForLevelChange("standard", "hardened");

    const after = await db.recentLocations.toArray();
    expect(after).toEqual(before);
  });

  it("deletes residual rows instead of rewriting them when the choice is off", async () => {
    await db.recentLocations.put({
      id: "residual",
      endpoint: stopEndpoint,
      usedAt: 1,
      usedAsOrigin: true,
    });
    usePrivacyChoicesStore.getState().setChoice("recents", "disabled");

    await migrateRecentsForLevelChange("standard", "hardened");

    expect(await db.recentLocations.count()).toBe(0);
    expect(__getRamRecentsForTests().size).toBe(0);
  });

  it("Hardened → Baseline (downgrade) decrypts records back to plaintext", async () => {
    usePrivacyStore.setState({ level: "hardened" });
    await recordRecent(stopEndpoint, {
      usedAsOrigin: true,
      now: () => 42,
    });
    const encRow = (await db.recentLocations.toArray())[0]!;
    expect("ct" in (encRow.endpoint as object)).toBe(true);

    await migrateRecentsForLevelChange("hardened", "baseline");

    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpoint).toEqual(stopEndpoint);
    expect(rows[0]!.usedAt).toBe(42);
  });

  it("is a no-op when there are no recents", async () => {
    await expect(
      migrateRecentsForLevelChange("standard", "paranoid"),
    ).resolves.toBeUndefined();
    expect(await db.recentLocations.count()).toBe(0);
    expect(__getRamRecentsForTests().size).toBe(0);
  });

  it("is invoked automatically by privacyStore.setLevel", async () => {
    // Seed a plaintext recent at Baseline, then move to Hardened via the
    // store. The listener registered at module load must fire and re-encrypt
    // without an explicit migrate call.
    usePrivacyStore.setState({ level: "baseline" });
    await recordRecent(stopEndpoint, {
      usedAsOrigin: false,
      now: () => 1,
    });

    const ok = await usePrivacyStore.getState().setLevel("hardened");
    expect(ok).toBe(true);

    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(1);
    const enc = rows[0]!.endpoint as EncryptedRecord;
    expect(enc.iv).toBeDefined();
    expect(enc.ct).toBeDefined();
  });

  it("setLevel downgrade prompts the confirm callback and aborts when it returns false", async () => {
    usePrivacyStore.setState({ level: "hardened" });
    await recordRecent(stopEndpoint, {
      usedAsOrigin: false,
      now: () => 1,
    });
    const beforeCount = await db.recentLocations.count();

    const calls: string[] = [];
    const ok = await usePrivacyStore.getState().setLevel("baseline", {
      confirm: (msg) => {
        calls.push(msg);
        return false;
      },
      downgradeMessage: "MSG",
    });

    expect(ok).toBe(false);
    expect(calls).toEqual(["MSG"]);
    // Hardened-floor recentsEncryption persists when the downgrade is rejected.
    expect(getPolicy().recentsEncryption).toBe("encrypted-30d");
    // Records untouched.
    expect(await db.recentLocations.count()).toBe(beforeCount);
  });

  it("setLevel downgrade proceeds when confirm returns true", async () => {
    usePrivacyStore.setState({ level: "hardened" });
    await recordRecent(stopEndpoint, {
      usedAsOrigin: true,
      now: () => 1,
    });

    const ok = await usePrivacyStore
      .getState()
      .setLevel("baseline", { confirm: () => true });

    expect(ok).toBe(true);
    // Baseline-floor recentsEncryption confirms the level has changed.
    expect(getPolicy().recentsEncryption).toBe("plaintext");
    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpoint).toEqual(stopEndpoint);
  });
});

describe("listRecents", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.recentLocations.clear();
    await db.installKey.clear();
    __clearRamRecentsForTests();
    __resetRecentsCacheForTests();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    usePrivacyStore.getState().reset();
  });

  afterEach(async () => {
    usePrivacyStore.getState().clearOverride("recentsEncryption");
    __clearRamRecentsForTests();
    __resetRecentsCacheForTests();
    await db.recentLocations.clear();
  });

  it("returns [] when off", async () => {
    usePrivacyStore.getState().setOverride("recentsEncryption", "off");
    expect(await listRecents()).toEqual([]);
    usePrivacyStore.getState().clearOverride("recentsEncryption");
  });

  it("returns RecentRef newest-first (plaintext tier)", async () => {
    usePrivacyStore.getState().setLevel("baseline"); // plaintext
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 10 });
    await recordRecent(geocodedEndpoint, { usedAsOrigin: false, now: () => 20 });
    const out = await listRecents();
    expect(out.map((r: RecentRef) => r.kind)).toEqual(["recent", "recent"]);
    expect(out[0]!.usedAt).toBe(20);
    expect(out[0]!.base.kind).toBe("geocoded");
    usePrivacyStore.getState().reset();
  });

  it("cache invalidates on recordRecent", async () => {
    usePrivacyStore.getState().setLevel("baseline");
    expect((await listRecents()).length).toBe(0);
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 5 });
    expect((await listRecents()).length).toBe(1); // not a stale [] from cache
    usePrivacyStore.getState().reset();
  });

  it("countRecents counts persisted + ram", async () => {
    usePrivacyStore.getState().setLevel("baseline");
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 10 });
    expect(await countRecents()).toBe(1);
    usePrivacyStore.getState().reset();
  });
});
