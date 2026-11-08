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

const DAY_MS = 24 * 60 * 60 * 1000;

describe("optional stop-use personalization", () => {
  beforeEach(async () => {
    localStorage.clear();
    await db.delete();
    await db.open();
    usePrivacyStore.getState().reset();
    usePrivacyChoicesStore.getState().reset();
    localStorage.setItem(
      PRIVACY_DATA_MIGRATION_KEY,
      PRIVACY_DATA_MIGRATION_VERSION,
    );
  });

  it("writes nothing before an explicit choice", async () => {
    await recordStopUsage("s1", () => 100);
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

  it("keeps the exact retention boundary and removes older rows", async () => {
    const now = 100 * DAY_MS;
    await db.usageStats.bulkPut([
      { stopId: "old", tapCount: 1, lastTapped: now - 30 * DAY_MS - 1 },
      { stopId: "edge", tapCount: 1, lastTapped: now - 30 * DAY_MS },
    ]);
    expect(await sweepStopUsage({ axis: "30d", now: () => now })).toBe(1);
    expect((await db.usageStats.toArray()).map((row) => row.stopId)).toEqual([
      "edge",
    ]);
  });

  it("enforces 7 days and clears all rows when the policy axis is off", async () => {
    const now = 20 * DAY_MS;
    await db.usageStats.bulkPut([
      { stopId: "old", tapCount: 1, lastTapped: now - 8 * DAY_MS },
      { stopId: "fresh", tapCount: 1, lastTapped: now - DAY_MS },
    ]);
    expect(await sweepStopUsage({ axis: "7d", now: () => now })).toBe(1);
    expect(await sweepStopUsage({ axis: "off", now: () => now })).toBe(1);
    expect(await db.usageStats.count()).toBe(0);
  });

  it("immediately enforces a stricter direct policy override", async () => {
    await db.usageStats.put({ stopId: "s1", tapCount: 1, lastTapped: 1 });

    usePrivacyStore.getState().setOverride("stopUsageRetention", "off");

    await vi.waitFor(async () => {
      expect(await db.usageStats.count()).toBe(0);
    });
  });

  it("fails closed when the migration marker is missing or policy forbids use", async () => {
    usePrivacyChoicesStore.getState().setChoice("personalization", "enabled");
    localStorage.removeItem(PRIVACY_DATA_MIGRATION_KEY);
    await recordStopUsage("s1");
    expect(await db.usageStats.count()).toBe(0);

    localStorage.setItem(
      PRIVACY_DATA_MIGRATION_KEY,
      PRIVACY_DATA_MIGRATION_VERSION,
    );
    usePrivacyStore.setState({ level: "strict" });
    await recordStopUsage("s1");
    expect(await db.usageStats.count()).toBe(0);
  });

  it("maps retention axes to their exact ceilings", () => {
    expect(retentionMsForStopUsage("30d")).toBe(30 * DAY_MS);
    expect(retentionMsForStopUsage("7d")).toBe(7 * DAY_MS);
    expect(retentionMsForStopUsage("off")).toBeNull();
  });
});

it("isolates reused stop IDs by captured city and counts concurrent taps atomically", async () => {
  const {useCityStore} = await import("../stores/cityStore.ts");
  const original = useCityStore.getState().activeCity;
  await db.cityUsageStats.clear();
  await db.usageStats.clear();
  localStorage.setItem(PRIVACY_DATA_MIGRATION_KEY, PRIVACY_DATA_MIGRATION_VERSION);
  usePrivacyStore.getState().reset();
  usePrivacyChoicesStore.getState().setChoice("personalization", "enabled");
  try {
    useCityStore.setState({activeCity: {...original, id: "vilnius"}});
    const pending = Promise.all([recordStopUsage("same", () => 100), recordStopUsage("same", () => 100)]);
    useCityStore.setState({activeCity: {...original, id: "krakow"}});
    await pending;
    expect((await loadStopUsage(["same"], () => 100)).size).toBe(0);
    await recordStopUsage("same", () => 100);
    expect((await loadStopUsage(["same"], () => 100)).get("same")?.tapCount).toBe(1);
    useCityStore.setState({activeCity: {...original, id: "vilnius"}});
    expect((await loadStopUsage(["same"], () => 100)).get("same")?.tapCount).toBe(2);
    expect(await sweepStopUsage({axis: "off"})).toBe(2);
    expect(await db.cityUsageStats.count()).toBe(0);
  } finally { useCityStore.setState({activeCity: original}); }
});
