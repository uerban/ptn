import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { db } from "../db/index.ts";
import { useFavoritesStore } from "../stores/favoritesStore.ts";
import { resetPersonalStorage } from "../test-helpers/personalStorage.ts";
import { getOrCreateInstallKey } from "./installKey.ts";
import { usePersonalStorageStatus, whenPersonalStorageSettled } from "./personalStorage.ts";
import {
  deleteUnreadablePersonalData,
  retryPersonalStorage,
} from "./personalStorageRecovery.ts";
import { DELAY_REPORTS_STORAGE_KEY, MAP_VIEWPORT_STORAGE_KEY } from "./privacyStorageKeys.ts";
import { sealString } from "./sealedLocalStorage.ts";

async function foreignKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

beforeEach(async () => {
  usePersonalStorageStatus.setState({ migration: "failed" });
  await whenPersonalStorageSettled();
  await resetPersonalStorage();
  usePersonalStorageStatus.setState({ migration: "complete", failure: null, keyMode: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(MAP_VIEWPORT_STORAGE_KEY);
  localStorage.removeItem(DELAY_REPORTS_STORAGE_KEY);
});

describe("deleteUnreadablePersonalData", () => {
  it("removes sealed localStorage values it cannot open and keeps readable ones", async () => {
    const key = await getOrCreateInstallKey();
    const readable = await sealString('{"lat":1}', key);
    localStorage.setItem(MAP_VIEWPORT_STORAGE_KEY, readable);
    localStorage.setItem(DELAY_REPORTS_STORAGE_KEY, await sealString("{}", await foreignKey()));

    await deleteUnreadablePersonalData();

    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBe(readable);
    expect(localStorage.getItem(DELAY_REPORTS_STORAGE_KEY)).toBeNull();
  });

  it("deletes everything personal and the key when the key itself is unreadable", async () => {
    const keyBefore = await getOrCreateInstallKey();
    localStorage.setItem(MAP_VIEWPORT_STORAGE_KEY, await sealString('{"lat":1}', keyBefore));
    await db.savedLocations.put({ id: "x", iv: new Uint8Array(12), ct: new Uint8Array(4) } as never);
    usePersonalStorageStatus.setState({ keyMode: "key-unreadable" });

    await deleteUnreadablePersonalData();

    expect(await db.savedLocations.count()).toBe(0);
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
    expect(await getOrCreateInstallKey()).not.toBe(keyBefore);
  });

  it("deletes legacy stop use so the restarted migration converts nothing", async () => {
    await db.cityUsageStats.put({ id: "tricity:s1", cityId: "tricity", stopId: "s1", tapCount: 3, lastTapped: 1 });
    usePersonalStorageStatus.setState({ keyMode: "key-unreadable" });

    await deleteUnreadablePersonalData();

    expect(await db.cityUsageStats.count()).toBe(0);
    expect(await db.personalUsage.count()).toBe(0);
  });
});

describe("retryPersonalStorage", () => {
  it("reloads sealed stores only when the retry succeeds", async () => {
    const rehydrate = vi.spyOn(useFavoritesStore.persist, "rehydrate");

    await resetPersonalStorage({ migrated: false });
    await db.recentLocations.put({ id: "stop:S-1", endpoint: {}, usedAt: 1 } as never);
    const read = vi
      .spyOn(db.installKey, "get")
      .mockRejectedValue(new DOMException("busy", "UnknownError"));
    expect(await retryPersonalStorage()).toBe("failed");
    expect(rehydrate).not.toHaveBeenCalled();

    read.mockRestore();
    expect(await retryPersonalStorage()).toBe("migrated");
    expect(rehydrate).toHaveBeenCalled();
  });
});
