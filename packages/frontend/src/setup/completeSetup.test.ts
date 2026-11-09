import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { canUse } from "../privacy/canUse.ts";
import { readOnboardingRecord } from "../services/onboardingRecord.ts";
import { LATEST_WHATS_NEW_ID } from "../services/whatsNew.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useNetworkDecisionsStore } from "../stores/networkDecisionsStore.ts";
import { useOnboardingStore } from "../stores/onboardingStore.ts";
import { getCurrentLevel, usePrivacyStore } from "../stores/privacyStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { completeSetup, setupPresentation } from "./completeSetup.ts";

vi.mock("./mapAssets.ts", () => ({ warmMapAssets: vi.fn(async () => {}) }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useNetworkDecisionsStore.getState().reset();
  usePrivacyStore.getState().reset();
  useSettingsStore.getState().setScheduleMode(false);
  useOnboardingStore.setState({ record: null, storageAvailable: true });
});

describe("completing setup", () => {
  it("uses the minimal offline map and nearby cards for both presentations", () => {
    expect(setupPresentation("text")).toEqual({ startMode: "text", mapDetail: "micromap", nearbyCards: true });
    expect(setupPresentation("map").mapDetail).toBe("micromap");
  });

  it("commits the journal, applies it, and marks What's new seen", async () => {
    const result = await completeSetup({ presetId: "recommended", startMode: "text" });
    expect(result.stored).toBe(true);
    const read = readOnboardingRecord();
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.record.applied).toBe(true);
    expect(read.record.seenWhatsNew).toBe(LATEST_WHATS_NEW_ID);
    expect(useSettingsStore.getState().scheduleMode).toBe(true);
    expect(useSettingsStore.getState().mapDetailMode).toBe("micromap");
    expect(canUse("operator.realtime")).toBe(true);
  });

  it("fetches map-only assets only when Map is chosen", async () => {
    const { warmMapAssets } = await import("./mapAssets.ts");
    await completeSetup({ presetId: "strict", startMode: "text" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warmMapAssets).not.toHaveBeenCalled();
    await completeSetup({ presetId: "strict", startMode: "map" });
    await vi.waitFor(() => expect(warmMapAssets).toHaveBeenCalledOnce());
  });

  it("proceeds on session state when storage cannot be written", async () => {
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      const result = await completeSetup({ presetId: "strict", startMode: "map" });
      expect(result.stored).toBe(false);
      expect(getCurrentLevel()).toBe("strict");
    } finally {
      setItem.mockRestore();
    }
  });

  it("switching cities keeps decisions and preferences", async () => {
    await completeSetup({ presetId: "recommended", startMode: "text" });
    const before = useNetworkDecisionsStore.getState().decisions;
    const current = useCityStore.getState().activeCity;
    useCityStore.getState().setActiveCity({ ...current, id: `${current.id}-other` });
    expect(useNetworkDecisionsStore.getState().decisions).toBe(before);
    expect(useSettingsStore.getState().scheduleMode).toBe(true);
    useCityStore.getState().setActiveCity(current);
  });
});
