import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { db } from "../db/index.ts";
import { usePrivacyChoicesStore } from "../stores/privacyChoicesStore.ts";
import { usePrivacyStore } from "../stores/privacyStore.ts";
import {
  loadStopUsage,
  recordStopUsage,
  retentionMsForStopUsage,
  sweepStopUsage,
} from "./stopUsage.ts";
import {
  PRIVACY_DATA_MIGRATION_KEY,
  PRIVACY_DATA_MIGRATION_VERSION,
} from "./privacyDataMigrationState.ts";
import { putPersonal } from "./personalStorage.ts";
import { rawTableText, resetPersonalStorage } from "../test-helpers/personalStorage.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("optional stop-use personalization", () => {
  beforeEach(async () => {
    localStorage.clear();
    await db.delete();
    await db.open();
    await resetPersonalStorage();
    usePrivacyStore.getState().reset();
    usePrivacyChoicesStore.getState().reset();
  });

  async function seed(rows: { stopId: string; tapCount: number; lastTapped: number }[]) {
    for (const row of rows) {
      await putPersonal("personalUsage", crypto.randomUUID(), row);
    }
  }

  async function storedStopIds(now: number): Promise<string[]> {
    usePrivacyChoicesStore.getState().setChoice("personalization", "enabled");
    const ids = ["old", "edge", "fresh", "s1"];
    return [...(await loadStopUsage(ids, () => now)).keys()].sort();
  }

  it("writes nothing before an explicit choice", async () => {
    await recordStopUsage("s1", () => 100);
    expect(await db.personalUsage.count()).toBe(0);
    expect(await db.usageStats.count()).toBe(0);
  });

  it("records and reads usage after opt-in", async () => {
    usePrivacyChoicesStore.getState().setChoice("personalization", "enabled");
    await recordStopUsage("s1", () => 100);
    await recordStopUsage("s1", () => 200);
    expect((await loadStopUsage(["s1"], () => 200)).get("s1")).toEqual({
      tapCount: 2,
      lastTapped: 200,
    });
  });

  it("stores neither the stop ID, count nor time outside the ciphertext", async () => {
    usePrivacyChoicesStore.getState().setChoice("personalization", "enabled");
    await recordStopUsage("STOP-CENTRAL-4471", () => 1_700_000_123_456);
    await recordStopUsage("STOP-CENTRAL-4471", () => 1_700_000_123_999);
    expect(await db.personalUsage.count()).toBe(1);
    expect(await db.usageStats.count()).toBe(0);
    const raw = await rawTableText("personalUsage");
    for (const leak of ["STOP-CENTRAL-4471", "1700000123999", "tapCount", "lastTapped"]) {
      expect(raw).not.toContain(leak);
    }
  });

  it("keeps the exact retention boundary and removes older rows", async () => {
    const now = 100 * DAY_MS;
    await seed([
      { stopId: "old", tapCount: 1, lastTapped: now - 30 * DAY_MS - 1 },
      { stopId: "edge", tapCount: 1, lastTapped: now - 30 * DAY_MS },
    ]);
    expect(await sweepStopUsage({ axis: "30d", now: () => now })).toBe(1);
    expect(await db.personalUsage.count()).toBe(1);
    expect(await storedStopIds(now)).toEqual(["edge"]);
  });

  it("enforces 7 days and clears all rows when the policy axis is off", async () => {
    const now = 20 * DAY_MS;
    await seed([
      { stopId: "old", tapCount: 1, lastTapped: now - 8 * DAY_MS },
      { stopId: "fresh", tapCount: 1, lastTapped: now - DAY_MS },
    ]);
    expect(await sweepStopUsage({ axis: "7d", now: () => now })).toBe(1);
    expect(await sweepStopUsage({ axis: "off", now: () => now })).toBe(1);
    expect(await db.personalUsage.count()).toBe(0);
  });

  it("immediately enforces a stricter direct policy override", async () => {
    await seed([{ stopId: "s1", tapCount: 1, lastTapped: 1 }]);

    usePrivacyStore.getState().setOverride("stopUsageRetention", "off");

    await vi.waitFor(async () => {
      expect(await db.personalUsage.count()).toBe(0);
    });
  });

  it("fails closed when the migration marker is missing or policy forbids use", async () => {
    usePrivacyChoicesStore.getState().setChoice("personalization", "enabled");
    localStorage.removeItem(PRIVACY_DATA_MIGRATION_KEY);
    await recordStopUsage("s1");
    expect(await db.personalUsage.count()).toBe(0);

    localStorage.setItem(
      PRIVACY_DATA_MIGRATION_KEY,
      PRIVACY_DATA_MIGRATION_VERSION,
    );
    usePrivacyStore.setState({ level: "strict" });
    await recordStopUsage("s1");
    expect(await db.personalUsage.count()).toBe(0);
  });

  it("maps retention axes to their exact ceilings", () => {
    expect(retentionMsForStopUsage("30d")).toBe(30 * DAY_MS);
    expect(retentionMsForStopUsage("7d")).toBe(7 * DAY_MS);
    expect(retentionMsForStopUsage("off")).toBeNull();
  });
});
