import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import type { BaseEndpoint } from "@pt/shared";
import { db } from "../db/index.ts";
import {
  canExportSaves,
  canShareSaves,
  deleteSave,
  listSaves,
  savePlace,
  saveRoutePair,
} from "./saves.ts";
import { __resetInstallKeyCacheForTests } from "./installKey.ts";
import { __resetDegradedModeForTests } from "./installKeyDegrade.ts";
import { __resetPersonalStorageForTests } from "./personalStorage.ts";
import { usePrivacyStore } from "../stores/privacyStore.ts";
import {
  findLeaks,
  rawTableText,
  resetPersonalStorage,
} from "../test-helpers/personalStorage.ts";

const origin: BaseEndpoint = {
  kind: "stop",
  stopId: "S1",
  name: "Central",
  lat: 54.35,
  lon: 18.65,
};

const destination: BaseEndpoint = {
  kind: "geocoded",
  lat: 54.4,
  lon: 18.6,
  label: "Długa 21",
  provider: "third-party-nominatim",
  confidence: 0.9,
};

const SENSITIVE = ["Central", "Długa", "54.35", "18.65", "Therapist", "S1"];

/** Simulates a reload: drops every in-memory cache but keeps IndexedDB. */
function reload(): void {
  __resetInstallKeyCacheForTests();
  __resetDegradedModeForTests();
  __resetPersonalStorageForTests();
}

beforeEach(async () => {
  await resetPersonalStorage();
  usePrivacyStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saveRoutePair", () => {
  it("stores the pair as an opaque sealed row with no readable field", async () => {
    const { save, stored } = await saveRoutePair(
      { origin, destination, alias: "Therapist" },
      { id: "pair-1", now: () => 1_234 },
    );
    expect(stored).toBe("stored");
    expect(save.durable).toBe(true);

    const rows = await db.savedLocations.toArray();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["id", "sealed"]);
    expect(findLeaks(await rawTableText("savedLocations"), [...SENSITIVE, "1234"])).toEqual([]);
  });

  it("round-trips both endpoints, alias and time", async () => {
    await saveRoutePair(
      { origin, destination, alias: " Daily " },
      { id: "pair-2", now: () => 9_000 },
    );
    const [save] = await listSaves();
    expect(save).toMatchObject({
      id: "pair-2",
      alias: "Daily",
      origin,
      destination,
      savedAt: 9_000,
      durable: true,
    });
  });

  it("treats alias as optional and generates distinct random ids", async () => {
    const a = await saveRoutePair({ origin, destination });
    const b = await saveRoutePair({ origin, destination });
    expect(a.save.alias).toBe("");
    expect(a.save.id).not.toBe(b.save.id);
    expect(a.save.id).not.toContain("S1");
  });

  it("is sealed the same way at every privacy level", async () => {
    for (const level of ["baseline", "standard", "hardened", "strict", "paranoid"] as const) {
      await resetPersonalStorage();
      await usePrivacyStore.getState().setLevel(level, { confirm: () => true });
      await saveRoutePair({ origin, destination, alias: "Therapist" });
      const raw = await rawTableText("savedLocations");
      expect(findLeaks(raw, SENSITIVE)).toEqual([]);
      expect((await listSaves())[0]!.alias).toBe("Therapist");
    }
  });
});

describe("savePlace (single-location save)", () => {
  it("writes a sealed record with no destination leg", async () => {
    await savePlace({ endpoint: destination, alias: "Clinic", placeType: "place" }, { id: "p-1" });
    expect(findLeaks(await rawTableText("savedLocations"), ["Clinic", "Długa"])).toEqual([]);
    const [save] = await listSaves();
    expect(save!.origin).toEqual(destination);
    expect(save!.destination).toBeUndefined();
    expect(save!.placeType).toBe("place");
  });
});

describe("persistence and level changes", () => {
  it("saves survive a reload and stay readable", async () => {
    await saveRoutePair({ origin, destination, alias: "Kept" }, { id: "keep" });
    reload();
    const saves = await listSaves();
    expect(saves.map((s) => s.alias)).toEqual(["Kept"]);
  });

  it("level changes keep every save without re-encoding it", async () => {
    await saveRoutePair({ origin, destination, alias: "Friend" }, { id: "s-6" });
    const before = await db.savedLocations.get("s-6");
    for (const level of ["paranoid", "standard", "baseline", "strict"] as const) {
      expect(await usePrivacyStore.getState().setLevel(level, { confirm: () => true })).toBe(true);
    }
    const after = await db.savedLocations.get("s-6");
    expect(after).toEqual(before);
    expect((await listSaves())[0]!.alias).toBe("Friend");
  });

  it("deleteSave removes the row", async () => {
    await saveRoutePair({ origin, destination }, { id: "gone" });
    await deleteSave("gone");
    expect(await db.savedLocations.count()).toBe(0);
    expect(await listSaves()).toEqual([]);
  });
});

describe("when the key cannot be read", () => {
  it("keeps a new save for this session only and never writes plaintext", async () => {
    // Create the key first so the failure is a read failure, not a missing row.
    await saveRoutePair({ origin, destination, alias: "Earlier" }, { id: "earlier" });
    reload();
    vi.spyOn(db.installKey, "get").mockRejectedValue(new Error("read failed"));

    const { stored, save } = await saveRoutePair(
      { origin, destination, alias: "Therapist" },
      { id: "later" },
    );
    expect(stored).toBe("session");
    expect(save.durable).toBe(false);
    expect(await db.savedLocations.count()).toBe(1);
    expect(findLeaks(await rawTableText("savedLocations"), SENSITIVE)).toEqual([]);
    // The stored key row is untouched: a read failure never replaces it.
    vi.restoreAllMocks();
    expect(await db.installKey.count()).toBeGreaterThan(0);
  });

  it("does not replace a stored key it failed to read", async () => {
    await saveRoutePair({ origin, destination }, { id: "first" });
    const keyRows = await db.installKey.toArray();
    reload();
    vi.spyOn(db.installKey, "get").mockRejectedValue(new Error("read failed"));
    await saveRoutePair({ origin, destination }, { id: "second" });
    vi.restoreAllMocks();
    expect(await db.installKey.toArray()).toEqual(keyRows);
  });
});

describe("export/share visibility helpers", () => {
  it("canExportSaves hides export at Strict and Paranoid only", () => {
    expect(canExportSaves("always")).toBe(true);
    expect(canExportSaves("always-no-export")).toBe(false);
    expect(canExportSaves("always-no-share")).toBe(false);
  });

  it("canShareSaves hides share at Paranoid only", () => {
    expect(canShareSaves("always")).toBe(true);
    expect(canShareSaves("always-no-export")).toBe(true);
    expect(canShareSaves("always-no-share")).toBe(false);
  });
});
