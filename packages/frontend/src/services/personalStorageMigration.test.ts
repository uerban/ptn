import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import type { BaseEndpoint } from "@pt/shared";
import { db } from "../db/index.ts";
import { encrypt } from "./cryptoBox.ts";
import { getOrCreateInstallKey } from "./installKey.ts";
import {
  PERSONAL_STORAGE_MARKER_KEY,
  isPersonalStorageMigrated,
  listPersonal,
  putPersonal,
  usePersonalStorageStatus,
  whenPersonalStorageSettled,
} from "./personalStorage.ts";
import {
  ACTIVITY_CACHE_PREFIXES,
  runPersonalStorageMigration,
  type CacheStorageLike,
} from "./personalStorageMigration.ts";
import { deleteAllPersonalData, deleteUnreadablePersonalData } from "./personalStorageRecovery.ts";
import { listRecents, __resetRecentsCacheForTests } from "./recents.ts";
import { listSaves } from "./saves.ts";
import { readSealedItem } from "./sealedLocalStorage.ts";
import { LEGACY_FAVORITES_KEY } from "./favoritesMigration.ts";
import { DELAY_REPORTS_STORAGE_KEY, MAP_VIEWPORT_STORAGE_KEY } from "./privacyStorageKeys.ts";
import { usePrivacyChoicesStore } from "../stores/privacyChoicesStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import {
  findLeaks,
  rawLocalStorageText,
  rawTableText,
  resetPersonalStorage,
} from "../test-helpers/personalStorage.ts";

const stop: BaseEndpoint = { kind: "stop", stopId: "S-77", name: "Oliwa", lat: 54.41, lon: 18.56 };
const clinic: BaseEndpoint = {
  kind: "geocoded",
  lat: 54.38,
  lon: 18.61,
  label: "Grunwaldzka 99",
  provider: "third-party-nominatim",
  confidence: 0.9,
};

const FAVORITES = JSON.stringify({
  state: {
    favorites: [
      {
        id: "f1",
        name: "Dom",
        type: "home",
        location: { lat: 54.35, lon: 18.65 },
        sortOrder: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  version: 0,
});
const VIEWPORT = JSON.stringify({ lat: 54.3521, lon: 18.6464, zoom: 15 });
const REPORTS = JSON.stringify({ state: { reports: [{ stopId: "S-88", note: "late" }] }, version: 0 });

const SENSITIVE = [
  "Oliwa",
  "S-77",
  "S-88",
  "Grunwaldzka",
  "Therapist",
  "Dom",
  "54.3521",
  "54.41",
  "stop:",
  "1700000000000",
];

const NO_LOCK = { locks: null, storage: null } as const;

function fakeCaches(names: string[]): CacheStorageLike & { names: string[] } {
  const state = { names: [...names] };
  return {
    get names() {
      return state.names;
    },
    keys: async () => [...state.names],
    delete: async (name: string) => {
      state.names = state.names.filter((n) => n !== name);
      return true;
    },
  };
}

/** Writes data the way earlier versions did: plaintext or per-field ciphertext. */
async function seedLegacy(): Promise<void> {
  const key = await getOrCreateInstallKey();
  await db.recentLocations.put({
    id: "stop:S-77",
    endpoint: stop,
    usedAt: 1_700_000_000_000,
    usedAsOrigin: true,
    cityId: useCityStore.getState().activeCity.id,
  } as never);
  await db.savedLocations.bulkPut([
    { id: "plain", endpoint: stop, alias: "Classes", savedAt: 1_700_000_000_000 },
    {
      id: "sealed-alias",
      endpoint: await encrypt(stop, key),
      destinationEndpoint: await encrypt(clinic, key),
      alias: "",
      aliasCipher: await encrypt("Therapist", key),
      savedAt: 1_700_000_000_001,
    },
  ] as never);
  await db.usageStats.put({ stopId: "S-77", tapCount: 3, lastTapped: 1_700_000_000_000 });
  localStorage.setItem(LEGACY_FAVORITES_KEY, FAVORITES);
  localStorage.setItem(MAP_VIEWPORT_STORAGE_KEY, VIEWPORT);
  localStorage.setItem(DELAY_REPORTS_STORAGE_KEY, REPORTS);
}

async function rawEverything(): Promise<string> {
  const tables = await Promise.all(
    ["recentLocations", "savedLocations", "personalUsage", "usageStats", "geocoderDedup"].map(
      rawTableText,
    ),
  );
  return tables.join("\n") + rawLocalStorageText();
}

beforeEach(async () => {
  // Stores hydrating at import time may have started a lazy run; let it finish
  // so it cannot mark the device converted after the reset below.
  usePersonalStorageStatus.setState({ migration: "failed" });
  await whenPersonalStorageSettled();
  await resetPersonalStorage({ migrated: false });
  usePrivacyChoicesStore.getState().setChoice("recents", "enabled");
  __resetRecentsCacheForTests();
  // The migration starts lazily for readers; tests run it explicitly.
  usePersonalStorageStatus.setState({ migration: "failed" });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["ptn-city", LEGACY_FAVORITES_KEY, MAP_VIEWPORT_STORAGE_KEY, DELAY_REPORTS_STORAGE_KEY]) {
    localStorage.removeItem(k);
  }
});

describe("runPersonalStorageMigration", () => {
  it("leaves no readable personal value in IndexedDB or localStorage", async () => {
    await seedLegacy();
    expect(findLeaks(await rawEverything(), SENSITIVE).length).toBeGreaterThan(0);

    expect(await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK })).toBe("migrated");
    expect(isPersonalStorageMigrated()).toBe(true);

    expect(findLeaks(await rawEverything(), SENSITIVE)).toEqual([]);
    expect(await db.usageStats.count()).toBe(0);
    expect(await db.personalUsage.count()).toBe(1);
    const recentIds = (await db.recentLocations.toArray()).map((r) => r.id);
    expect(recentIds).not.toContain("stop:S-77");
  });

  it("preserves every save, recent and sealed localStorage value", async () => {
    await seedLegacy();
    await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK });

    const saves = await listSaves();
    expect(saves.map((s) => s.id).sort()).toEqual(["plain", "sealed-alias"]);
    const paired = saves.find((s) => s.id === "sealed-alias")!;
    expect(paired).toMatchObject({ alias: "Therapist", origin: stop, destination: clinic });
    expect(saves.find((s) => s.id === "plain")!.alias).toBe("Classes");

    const recents = await listRecents();
    expect(recents).toHaveLength(1);
    expect(recents[0]!.base).toEqual(stop);
    expect(recents[0]!.usedAt).toBe(1_700_000_000_000);

    expect(await readSealedItem(LEGACY_FAVORITES_KEY)).toBe(FAVORITES);
    expect(await readSealedItem(MAP_VIEWPORT_STORAGE_KEY)).toBe(VIEWPORT);
    expect(await readSealedItem(DELAY_REPORTS_STORAGE_KEY)).toBe(REPORTS);
  });

  it("moves the city of legacy records inside the sealed payload", async () => {
    // No city is known: rows without one stay untagged.
    localStorage.removeItem("ptn-city");
    await db.recentLocations.put({
      id: "stop:S-77",
      endpoint: stop,
      usedAt: 1_700_000_000_000,
      cityId: "vilnius",
    } as never);
    await db.recentLocations.put({
      id: "stop:S-88",
      endpoint: { ...stop, stopId: "S-88" },
      usedAt: 1_700_000_000_001,
    } as never);
    await db.cityUsageStats.put({
      id: "vilnius:S-77",
      cityId: "vilnius",
      stopId: "S-77",
      tapCount: 2,
      lastTapped: 1_700_000_000_000,
    } as never);

    expect(await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK })).toBe("migrated");

    expect(await db.cityUsageStats.count()).toBe(0);
    const raw = (await Promise.all(["recentLocations", "personalUsage"].map(rawTableText))).join("\n");
    expect(findLeaks(raw, ["vilnius", "S-77", "S-88"])).toEqual([]);
    const usage = await listPersonal<{ stopId: string; cityId?: string }>("personalUsage");
    expect(usage.map((u) => u.value)).toEqual([expect.objectContaining({ stopId: "S-77", cityId: "vilnius" })]);
    const recents = await listPersonal<{ cityId?: string }>("recentLocations");
    expect(recents.map((r) => r.value.cityId ?? null).sort()).toEqual(["vilnius", null].sort());
  });

  it("tags records without a city with the city selected at migration time", async () => {
    // An older store kept the whole city, under its former id.
    localStorage.setItem("ptn-city", JSON.stringify({ state: { activeCity: { id: "gdansk" } }, version: 0 }));
    await db.recentLocations.bulkPut([
      { id: "stop:S-77", endpoint: stop, usedAt: 1_700_000_000_000, cityId: "vilnius" },
      { id: "stop:S-88", endpoint: { ...stop, stopId: "S-88" }, usedAt: 1_700_000_000_001 },
    ] as never);
    await db.savedLocations.bulkPut([
      { id: "home", endpoint: stop, alias: "Home", savedAt: 1 },
      { id: "work", endpoint: stop, alias: "Work", savedAt: 2, cityId: "paris" },
    ] as never);

    expect(await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK })).toBe("migrated");

    const recents = await listPersonal<{ endpoint: BaseEndpoint; cityId?: string }>("recentLocations");
    expect(Object.fromEntries(recents.map((r) => [(r.value.endpoint as { stopId: string }).stopId, r.value.cityId])))
      .toEqual({ "S-77": "vilnius", "S-88": "tricity" });
    const saves = await listPersonal<{ alias: string; cityId?: string }>("savedLocations");
    expect(Object.fromEntries(saves.map((r) => [r.value.alias, r.value.cityId]))).toEqual({
      Home: "tricity",
      Work: "paris",
    });
  });

  it("reads the selected city from the current store shape, also for per-city usage", async () => {
    localStorage.setItem("ptn-city", JSON.stringify({ state: { currentCityId: "vilnius" }, version: 1 }));
    await db.recentLocations.put({ id: "stop:S-88", endpoint: { ...stop, stopId: "S-88" }, usedAt: 1 } as never);
    await db.cityUsageStats.put({ id: "x:S-77", stopId: "S-77", tapCount: 1, lastTapped: 1 } as never);

    expect(await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK })).toBe("migrated");

    const recents = await listPersonal<{ cityId?: string }>("recentLocations");
    expect(recents.map((r) => r.value.cityId)).toEqual(["vilnius"]);
    const usage = await listPersonal<{ stopId: string; cityId?: string }>("personalUsage");
    expect(usage.map((u) => u.value)).toEqual([expect.objectContaining({ stopId: "S-77", cityId: "vilnius" })]);
  });

  it("leaves records untagged when the stored city cannot be parsed", async () => {
    localStorage.setItem("ptn-city", "{not json");
    await db.recentLocations.put({ id: "stop:S-88", endpoint: { ...stop, stopId: "S-88" }, usedAt: 1 } as never);

    expect(await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK })).toBe("migrated");

    const recents = await listPersonal<{ cityId?: string }>("recentLocations");
    expect(recents.map((r) => r.value.cityId ?? null)).toEqual([null]);
  });

  it("fails without throwing when the browser blocks localStorage itself", async () => {
    vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK })).toBe("failed");
    expect(usePersonalStorageStatus.getState()).toMatchObject({
      migration: "failed",
      failure: "key-unavailable",
    });
  });

  it("drops the geocoder dedup cache and purges activity caches only", async () => {
    await db.geocoderDedup.put({ queryHash: "deadbeef", providerId: "x", createdAt: 1 } as never);
    const caches = fakeCaches([
      ...ACTIVITY_CACHE_PREFIXES.map((p) => `${p}-v1`),
      "workbox-precache-v2",
    ]);
    await runPersonalStorageMigration({ cacheStorage: caches, lock: NO_LOCK });
    expect(await db.geocoderDedup.count()).toBe(0);
    expect(caches.names).toEqual(["workbox-precache-v2"]);
  });

  it("resumes after an interruption without losing or duplicating records", async () => {
    await seedLegacy();
    let converted = 0;
    const result = await runPersonalStorageMigration({
      cacheStorage: null,
      lock: NO_LOCK,
      onRecordConverted: () => {
        converted += 1;
        if (converted === 2) throw new Error("tab closed");
      },
    });
    expect(result).toBe("failed");
    expect(isPersonalStorageMigrated()).toBe(false);
    expect(usePersonalStorageStatus.getState()).toMatchObject({ migration: "failed", failure: "failed" });
    // Readers see nothing until the conversion completes.
    expect(await listSaves()).toEqual([]);

    expect(await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK })).toBe("migrated");
    expect(await db.recentLocations.count()).toBe(1);
    expect(await db.savedLocations.count()).toBe(2);
    expect(await db.personalUsage.count()).toBe(1);
    expect((await listSaves()).map((s) => s.alias).sort()).toEqual(["Classes", "Therapist"]);
    expect(findLeaks(await rawEverything(), SENSITIVE)).toEqual([]);
  });

  it("reports a full device and keeps the plaintext source until it can be sealed", async () => {
    await seedLegacy();
    const real = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((name: string, value: string) => {
      if (name === LEGACY_FAVORITES_KEY) {
        throw new DOMException("full", "QuotaExceededError");
      }
      real(name, value);
    });
    expect(await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK })).toBe("failed");
    expect(usePersonalStorageStatus.getState().failure).toBe("storage-full");
    expect(localStorage.getItem(LEGACY_FAVORITES_KEY)).toBe(FAVORITES);
    expect(localStorage.getItem(PERSONAL_STORAGE_MARKER_KEY)).toBeNull();

    vi.restoreAllMocks();
    expect(await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK })).toBe("migrated");
    expect(await readSealedItem(LEGACY_FAVORITES_KEY)).toBe(FAVORITES);
  });

  it("fails as key-unavailable when the key cannot be stored, leaving data in place", async () => {
    await db.recentLocations.put({ id: "stop:S-77", endpoint: stop, usedAt: 1, usedAsOrigin: true } as never);
    vi.spyOn(db.installKey, "add").mockRejectedValue(new DOMException("denied", "UnknownError"));
    expect(await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK })).toBe("failed");
    expect(usePersonalStorageStatus.getState().failure).toBe("key-unavailable");
    expect(await db.recentLocations.get("stop:S-77")).toBeDefined();
    // New personal records are kept for this session only.
    expect(await putPersonal("savedLocations", "new", { alias: "x" })).toBe("session");
  });

  it("waits for another tab holding the lock and does not convert twice", async () => {
    await seedLegacy();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let queue: Promise<unknown> = held;
    const locks = {
      request<T>(_n: string, _o: { mode: "exclusive" }, fn: () => Promise<T>): Promise<T> {
        const run = queue.then(fn);
        queue = run.catch(() => {});
        return run;
      },
    };
    const mine = runPersonalStorageMigration({ cacheStorage: null, lock: { locks } });
    // The other tab finishes the conversion while it holds the lock.
    localStorage.setItem(PERSONAL_STORAGE_MARKER_KEY, "1");
    release();
    expect(await mine).toBe("already-complete");
    // This tab converted nothing: the legacy rows are untouched.
    expect(await db.recentLocations.get("stop:S-77")).toBeDefined();
  });

  it("quarantines a legacy record it cannot decrypt, sealed, until deleted", async () => {
    const otherKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    await getOrCreateInstallKey();
    await db.savedLocations.bulkPut([
      { id: "ok", endpoint: stop, alias: "Classes", savedAt: 1 },
      { id: "lost", endpoint: await encrypt(clinic, otherKey), alias: "Therapist", savedAt: 2 },
    ] as never);

    expect(await runPersonalStorageMigration({ cacheStorage: null, lock: NO_LOCK })).toBe("migrated");
    expect(await db.savedLocations.count()).toBe(2);
    expect(findLeaks(await rawTableText("savedLocations"), ["Therapist", "Classes", "Oliwa"])).toEqual([]);
    expect((await listSaves()).map((s) => s.id)).toEqual(["ok"]);
    expect(usePersonalStorageStatus.getState().unreadable).toBe(1);

    await deleteUnreadablePersonalData();
    expect(await db.savedLocations.count()).toBe(1);
    expect(usePersonalStorageStatus.getState().unreadable).toBe(0);
    expect((await listSaves()).map((s) => s.id)).toEqual(["ok"]);
  });
});

describe("deleteAllPersonalData", () => {
  it("removes every personal record and key, then completes with nothing to convert", async () => {
    await seedLegacy();
    const keyBefore = await getOrCreateInstallKey();
    await deleteAllPersonalData();
    for (const t of ["recentLocations", "savedLocations", "personalUsage", "usageStats", "geocoderDedup"]) {
      expect(await db.table(t).count()).toBe(0);
    }
    for (const k of [LEGACY_FAVORITES_KEY, MAP_VIEWPORT_STORAGE_KEY, DELAY_REPORTS_STORAGE_KEY]) {
      expect(localStorage.getItem(k)).toBeNull();
    }
    expect(isPersonalStorageMigrated()).toBe(true);
    expect(usePersonalStorageStatus.getState().migration).toBe("complete");
    expect(await getOrCreateInstallKey()).not.toBe(keyBefore);
  });
});
