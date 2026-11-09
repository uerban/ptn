import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { db } from "../db/index.ts";
import { useDelayReportStore } from "../stores/delayReportStore.ts";
import {
  PRIVACY_DATA_MIGRATION_KEY,
  PRIVACY_DATA_MIGRATION_VERSION,
} from "./privacyDataMigrationState.ts";
import { runPrivacyDataMigration } from "./privacyDataMigration.ts";

describe("runPrivacyDataMigration", () => {
  beforeEach(async () => {
    localStorage.clear();
    await db.delete();
    await db.open();
    useDelayReportStore.setState({ reports: [] });
  });

  it("removes legacy optional history but preserves saves and public data", async () => {
    await db.recentLocations.put({
      id: "recent",
      endpoint: { kind: "stop", stopId: "s1", name: "Stop", lat: 1, lon: 2 },
      usedAt: 1,
      usedAsOrigin: true,
    } as never);
    await db.usageStats.put({ stopId: "s1", tapCount: 3, lastTapped: 1 });
    await db.savedLocations.put({
      id: "home",
      endpoint: { kind: "stop", stopId: "s1", name: "Stop", lat: 1, lon: 2 },
      alias: "Home",
      savedAt: 1,
      encrypted: false,
    } as never);
    await db.stops.put({
      id: "s1",
      name: "Stop",
      location: { lat: 1, lon: 2 },
      lastSeen: Date.now(),
    });
    localStorage.setItem("ptn-map-viewport", "sensitive");
    localStorage.setItem("ptn-settings", "preserve");
    localStorage.setItem("ptn-delay-reports", "legacy reports");

    expect(await runPrivacyDataMigration()).toBe("migrated");

    expect(await db.recentLocations.count()).toBe(0);
    expect(await db.usageStats.count()).toBe(0);
    expect(localStorage.getItem("ptn-map-viewport")).toBeNull();
    expect(localStorage.getItem("ptn-delay-reports")).toBeNull();
    expect(await db.savedLocations.count()).toBe(1);
    expect(await db.stops.count()).toBe(1);
    expect(localStorage.getItem("ptn-settings")).toBe("preserve");
    expect(localStorage.getItem(PRIVACY_DATA_MIGRATION_KEY)).toBe(
      PRIVACY_DATA_MIGRATION_VERSION,
    );
  });

  it("marks a fresh install complete after idempotent empty deletes", async () => {
    await expect(runPrivacyDataMigration()).resolves.toBe("migrated");
    await expect(runPrivacyDataMigration()).resolves.toBe("already-complete");
  });

  it("does not commit the marker after a partial failure and retries next time", async () => {
    const failOnce = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValue(undefined);
    const clearRecents = vi.fn(async () => {});
    const clearViewport = vi.fn(async () => {});
    const clearLocalReports = vi.fn(async () => {});
    const actions = {
      clearRecents,
      clearUsageStats: failOnce,
      clearViewport,
      clearLocalReports,
    };

    await expect(runPrivacyDataMigration({ actions })).rejects.toThrow("blocked");
    expect(localStorage.getItem(PRIVACY_DATA_MIGRATION_KEY)).toBeNull();
    expect(clearViewport).not.toHaveBeenCalled();

    await expect(runPrivacyDataMigration({ actions })).resolves.toBe("migrated");
    expect(clearRecents).toHaveBeenCalledTimes(2);
    expect(failOnce).toHaveBeenCalledTimes(2);
  });

  it("does not rerun cleanup when the completion marker is current", async () => {
    localStorage.setItem(
      PRIVACY_DATA_MIGRATION_KEY,
      PRIVACY_DATA_MIGRATION_VERSION,
    );
    const clearRecents = vi.fn(async () => {});
    const actions = {
      clearRecents,
      clearUsageStats: vi.fn(async () => {}),
      clearViewport: vi.fn(async () => {}),
      clearLocalReports: vi.fn(async () => {}),
    };

    expect(await runPrivacyDataMigration({ actions })).toBe("already-complete");
    expect(clearRecents).not.toHaveBeenCalled();
  });
});
