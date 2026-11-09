import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import type { BaseEndpoint, RecentRef } from "@pt/shared";
import { db } from "../db/index.ts";
import { useCityStore } from "../stores/cityStore.ts";
import {
  MAX_RECENTS,
  RECENTS_SWEEP_INTERVAL_MS,
  __getRamRecentsForTests,
  __resetRecentsCacheForTests,
  clearRecents,
  countRecents,
  endpointFingerprint,
  listRecents,
  migrateRecentsForLevelChange,
  recordRecent,
  startRecentsSweep,
  stopRecentsSweep,
  sweepRecents,
  tierForRecentsAxis,
  ttlForRecentsAxis,
} from "./recents.ts";
import { __resetInstallKeyCacheForTests } from "./installKey.ts";
import { __resetDegradedModeForTests } from "./installKeyDegrade.ts";
import {
  PERSONAL_CLEARS_STORAGE_KEY,
  __resetPersonalStorageForTests,
  putPersonal,
} from "./personalStorage.ts";
import { getPolicy, usePrivacyStore } from "../stores/privacyStore.ts";
import { usePrivacyChoicesStore } from "../stores/privacyChoicesStore.ts";
import {
  findLeaks,
  rawTableText,
  resetPersonalStorage,
} from "../test-helpers/personalStorage.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

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

const SENSITIVE = ["Central", "Długa", "54.35", "18.65", "S1", "stop:"];

function reload(): void {
  __resetInstallKeyCacheForTests();
  __resetDegradedModeForTests();
  __resetPersonalStorageForTests();
  __resetRecentsCacheForTests();
}

beforeEach(async () => {
  await resetPersonalStorage();
  __resetRecentsCacheForTests();
  usePrivacyStore.getState().reset();
  usePrivacyChoicesStore.getState().setChoice("recents", "enabled");
});

afterEach(() => {
  stopRecentsSweep();
  vi.restoreAllMocks();
});

describe("axis helpers", () => {
  it("maps every persisted axis to the encrypted tier", () => {
    expect(tierForRecentsAxis("encrypted")).toBe("encrypted");
    expect(tierForRecentsAxis("encrypted-30d")).toBe("encrypted");
    expect(tierForRecentsAxis("encrypted-7d")).toBe("encrypted");
    expect(tierForRecentsAxis("ram-only")).toBe("ram-only");
    expect(tierForRecentsAxis("off")).toBe("ram-only");
  });

  it("derives TTLs only for the time-limited axes", () => {
    expect(ttlForRecentsAxis("encrypted")).toBeNull();
    expect(ttlForRecentsAxis("encrypted-30d")).toBe(30 * DAY_MS);
    expect(ttlForRecentsAxis("encrypted-7d")).toBe(7 * DAY_MS);
  });

  it("fingerprints group endpoints by member set", () => {
    expect(
      endpointFingerprint({
        kind: "stopGroup",
        stopIds: ["b", "a"],
        label: "G",
        lat: 0,
        lon: 0,
      }),
    ).toBe("group:a,b");
  });
});

describe("recordRecent", () => {
  it("stores a sealed row under a random id with no readable field", async () => {
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 4_242 });
    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["id", "sealed"]);
    expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(findLeaks(await rawTableText("recentLocations"), [...SENSITIVE, "4242"])).toEqual([]);
  });

  it("dedupes by endpoint in memory and refreshes usedAt, also across a reload", async () => {
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 10 });
    const [first] = await db.recentLocations.toArray();
    reload();
    await recordRecent(stopEndpoint, { usedAsOrigin: false, now: () => 20 });
    const rows = await db.recentLocations.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first!.id);
    const out = await listRecents();
    expect(out).toHaveLength(1);
    expect(out[0]!.usedAt).toBe(20);
    expect(out[0]!.usedAsOrigin).toBe(false);
  });

  it("evicts the oldest by usedAt when inserts exceed the cap", async () => {
    for (let i = 0; i < MAX_RECENTS + 2; i += 1) {
      await recordRecent(
        { ...stopEndpoint, stopId: `S${i}`, name: `Stop ${i}` },
        { usedAsOrigin: false, now: () => 1_000 + i },
      );
    }
    expect(await db.recentLocations.count()).toBe(MAX_RECENTS);
    expect(await countRecents()).toBe(MAX_RECENTS);
    const fingerprints = (await __getRamRecentsForTests()).size;
    expect(fingerprints).toBe(0);
  });

  it("keeps Paranoid recents for this session only and drops them on reload", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 1 });
    expect(await db.recentLocations.count()).toBe(0);
    expect((await __getRamRecentsForTests()).size).toBe(1);
    expect(await listRecents()).toHaveLength(1);
    reload();
    expect(await listRecents()).toEqual([]);
  });

  it("records nothing when the axis is off or the choice is not enabled", async () => {
    usePrivacyStore.getState().setOverride("recentsEncryption", "off");
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    usePrivacyStore.getState().clearOverride("recentsEncryption");
    usePrivacyChoicesStore.getState().setChoice("recents", "unset");
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    expect(await db.recentLocations.count()).toBe(0);
    expect((await __getRamRecentsForTests()).size).toBe(0);
  });

  it("keeps a recent for this session when the key cannot be read", async () => {
    await recordRecent(geocodedEndpoint, { usedAsOrigin: true, now: () => 1 });
    reload();
    vi.spyOn(db.installKey, "get").mockRejectedValue(new Error("read failed"));
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 2 });
    expect(await db.recentLocations.count()).toBe(1);
    expect(findLeaks(await rawTableText("recentLocations"), SENSITIVE)).toEqual([]);
    expect((await __getRamRecentsForTests()).size).toBe(1);
  });
});

describe("sweepRecents", () => {
  it("decrypts, then removes rows older than 30d at Hardened and keeps fresh ones", async () => {
    await usePrivacyStore.getState().setLevel("hardened");
    const now = 100 * DAY_MS;
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => now - 31 * DAY_MS });
    await recordRecent(geocodedEndpoint, { usedAsOrigin: true, now: () => now - DAY_MS });
    expect(await sweepRecents({ now: () => now })).toBe(1);
    const out = await listRecents();
    expect(out.map((r: RecentRef) => r.base.kind)).toEqual(["geocoded"]);
  });

  it("removes rows older than 7d at Strict", async () => {
    await usePrivacyStore.getState().setLevel("strict");
    const now = 100 * DAY_MS;
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => now - 8 * DAY_MS });
    expect(await sweepRecents({ now: () => now })).toBe(1);
    expect(await db.recentLocations.count()).toBe(0);
  });

  it("keeps everything when the axis has no TTL, and accepts an axis override", async () => {
    const now = 100 * DAY_MS;
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 1 });
    expect(await sweepRecents({ now: () => now })).toBe(0);
    expect(await sweepRecents({ now: () => now, axis: "encrypted-7d" })).toBe(1);
  });

  it("runs once on startup and again on each interval", async () => {
    expect(RECENTS_SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
    await usePrivacyStore.getState().setLevel("strict");
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => Date.now() - 20 * DAY_MS });
    const stop = startRecentsSweep({ intervalMs: 30 });
    try {
      await vi.waitFor(async () => {
        expect(await db.recentLocations.count()).toBe(0);
      });
      await recordRecent(geocodedEndpoint, {
        usedAsOrigin: true,
        now: () => Date.now() - 20 * DAY_MS,
      });
      await vi.waitFor(async () => {
        expect(await db.recentLocations.count()).toBe(0);
      });
    } finally {
      stop();
    }
  });
});

describe("clearRecents", () => {
  it("drops persisted, unreadable and session entries", async () => {
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    await putPersonal("recentLocations", "session-1", { endpoint: geocodedEndpoint, usedAt: 1, usedAsOrigin: false }, { sessionOnly: true });
    await db.recentLocations.put({ id: "broken", sealed: { iv: new Uint8Array(12), ct: new Uint8Array(4) } } as never);
    await clearRecents();
    expect(await db.recentLocations.count()).toBe(0);
    expect(await listRecents()).toEqual([]);
  });

  /** Runs `during` once, while the next record is being sealed. */
  function whileSealing(during: () => Promise<unknown>): Promise<unknown>[] {
    const pending: Promise<unknown>[] = [];
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "encrypt").mockImplementation((...args) => {
      spy.mockRestore();
      pending.push(during());
      return encrypt(...args);
    });
    return pending;
  }

  it("a recent being sealed when recents are switched off and cleared is not stored", async () => {
    const pending = whileSealing(async () => {
      usePrivacyChoicesStore.getState().setChoice("recents", "disabled");
      await clearRecents();
    });
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    await Promise.all(pending);

    expect(pending).toHaveLength(1);
    expect(await db.recentLocations.count()).toBe(0);
    usePrivacyChoicesStore.getState().setChoice("recents", "enabled");
    expect(await countRecents()).toBe(0);
  });

  it("a recent being sealed when history is cleared is not stored", async () => {
    const pending = whileSealing(() => clearRecents());
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    await Promise.all(pending);

    expect(pending).toHaveLength(1);
    expect(await db.recentLocations.count()).toBe(0);
    expect(await listRecents()).toEqual([]);
  });

  it("a recent recorded while history is cleared during the read of existing recents is not stored", async () => {
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    const pending: Promise<unknown>[] = [];
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "decrypt").mockImplementation((...args) => {
      spy.mockRestore();
      pending.push(clearRecents());
      return decrypt(...args);
    });
    await recordRecent(geocodedEndpoint, { usedAsOrigin: false });
    await Promise.all(pending);

    expect(pending).toHaveLength(1);
    expect(await db.recentLocations.count()).toBe(0);
    expect(await countRecents()).toBe(0);
  });

  it("a recent recorded while another tab clears history during the read of existing recents is not stored", async () => {
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    const pending: Promise<unknown>[] = [];
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "decrypt").mockImplementation((...args) => {
      spy.mockRestore();
      // What another tab's clear leaves behind: a new clear mark and an
      // emptied table. This tab's own state does not change.
      localStorage.setItem(
        PERSONAL_CLEARS_STORAGE_KEY,
        JSON.stringify({ recentLocations: "other-tab-clear" }),
      );
      pending.push(db.recentLocations.clear());
      return decrypt(...args);
    });
    await recordRecent(geocodedEndpoint, { usedAsOrigin: false });
    await Promise.all(pending);

    expect(pending).toHaveLength(1);
    expect(await db.recentLocations.count()).toBe(0);
    expect(await countRecents()).toBe(0);
  });

  it("a recent being sealed when the level moves recents to this session is not stored", async () => {
    const pending = whileSealing(() => usePrivacyStore.getState().setLevel("paranoid"));
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    await Promise.all(pending);

    expect(pending).toHaveLength(1);
    expect(getPolicy().recentsEncryption).toBe("ram-only");
    expect(await db.recentLocations.count()).toBe(0);
  });
});

describe("migrateRecentsForLevelChange", () => {
  it("Standard → Hardened leaves sealed rows as they are", async () => {
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    const before = await db.recentLocations.toArray();
    await migrateRecentsForLevelChange("standard", "hardened");
    expect(await db.recentLocations.toArray()).toEqual(before);
  });

  it("→ Paranoid moves stored recents into this session and deletes the stored copy", async () => {
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    await usePrivacyStore.getState().setLevel("paranoid");
    expect(await db.recentLocations.count()).toBe(0);
    expect(await listRecents()).toHaveLength(1);
  });

  it("Paranoid → Standard stores session recents sealed", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    await usePrivacyStore.getState().setLevel("standard", { confirm: () => true });
    expect(await db.recentLocations.count()).toBe(1);
    expect(findLeaks(await rawTableText("recentLocations"), SENSITIVE)).toEqual([]);
    expect((await __getRamRecentsForTests()).size).toBe(0);
  });

  it("→ Paranoid keeps unreadable rows for the rider to delete", async () => {
    await db.recentLocations.put({ id: "broken", sealed: { iv: new Uint8Array(12), ct: new Uint8Array(4) } } as never);
    await migrateRecentsForLevelChange("standard", "paranoid");
    expect(await db.recentLocations.get("broken")).toBeDefined();
  });

  it("deletes everything when the recents choice was withdrawn", async () => {
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    usePrivacyChoicesStore.getState().setChoice("recents", "disabled");
    await migrateRecentsForLevelChange("standard", "hardened");
    expect(await db.recentLocations.count()).toBe(0);
  });
});

describe("listRecents", () => {
  it("returns [] when off", async () => {
    await recordRecent(stopEndpoint, { usedAsOrigin: true });
    usePrivacyStore.getState().setOverride("recentsEncryption", "off");
    expect(await listRecents()).toEqual([]);
    expect(await countRecents()).toBe(0);
    usePrivacyStore.getState().clearOverride("recentsEncryption");
  });

  it("returns RecentRefs newest first and invalidates its cache on writes", async () => {
    expect(await listRecents()).toEqual([]);
    await recordRecent(stopEndpoint, { usedAsOrigin: true, now: () => 10 });
    await recordRecent(geocodedEndpoint, { usedAsOrigin: false, now: () => 20 });
    const out = await listRecents();
    expect(out.map((r) => r.kind)).toEqual(["recent", "recent"]);
    expect(out[0]!.base).toEqual(geocodedEndpoint);
    expect(out[1]!.base).toEqual(stopEndpoint);
  });
});

describe("per-city recents", () => {
  it("keeps same-endpoint city recents independent through cache reuse, reloads and privacy tier changes", async () => {
    const original = useCityStore.getState().activeCity;
    try {
      useCityStore.setState({activeCity: {...original, id: "vilnius"}});
      const pending = recordRecent(stopEndpoint, {usedAsOrigin: true});
      useCityStore.setState({activeCity: {...original, id: "krakow"}});
      await pending;
      expect(await listRecents()).toEqual([]);
      await recordRecent({...stopEndpoint, name: "Other city stop"}, {usedAsOrigin: false});
      expect((await listRecents())[0]?.base).toMatchObject({name: "Other city stop"});
      useCityStore.setState({activeCity: {...original, id: "vilnius"}});
      expect((await listRecents())[0]?.base).toMatchObject({name: stopEndpoint.name});
      await migrateRecentsForLevelChange("hardened", "paranoid");
      usePrivacyStore.setState({level: "paranoid"});
      expect((await listRecents())[0]?.base).toMatchObject({name: stopEndpoint.name});
      await migrateRecentsForLevelChange("paranoid", "hardened");
      usePrivacyStore.setState({level: "hardened"});
      db.close();
      await db.open();
      reload();
      expect((await listRecents())[0]?.base).toMatchObject({name: stopEndpoint.name});
      // Two sealed rows; neither city nor endpoint is readable at rest.
      const rows = await db.recentLocations.toArray();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => Object.keys(row).sort().join() === "id,sealed")).toBe(true);
      expect(findLeaks(await rawTableText("recentLocations"), ["vilnius", "krakow", ...SENSITIVE])).toEqual([]);
    } finally { useCityStore.setState({activeCity: original}); }
  });

  it("never lists a legacy recent without a city", async () => {
    await putPersonal("recentLocations", crypto.randomUUID(), {
      endpoint: stopEndpoint, usedAt: 5, usedAsOrigin: true,
    });
    expect(await listRecents()).toEqual([]);
    expect(await countRecents()).toBe(1);
  });
});
