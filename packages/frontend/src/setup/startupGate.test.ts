import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CityConfig } from "../config/cities.ts";

const showSetupShell = vi.fn(async () => {});
const deviceCities = {
  records: [] as { cityId: string; city: CityConfig; sizeBytes: number }[],
  live: new Set<string>(),
  listCalls: 0,
  liveCalls: [] as string[],
};

vi.mock("../components/Onboarding/mountSetupShell.tsx", () => ({ showSetupShell }));
vi.mock("../db/migrationRunner.ts", () => ({ ensureDbReady: async () => {} }));
vi.mock("../db/dataSchemaVersion.ts", () => ({ ensureDataSchemaUpToDate: async () => ({ kind: "ok" }) }));
vi.mock("../services/deviceCities.ts", () => ({
  listDeviceCities: async () => {
    deviceCities.listCalls += 1;
    return deviceCities.records;
  },
  hasLiveDeviceCity: async (id: string) => {
    deviceCities.liveCalls.push(id);
    return deviceCities.live.has(id);
  },
}));

const city = (id: string): CityConfig =>
  ({
    id,
    name: id,
    tz: "Europe/Vilnius",
    available: true,
    center: { lat: 0, lon: 0 },
    bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
  }) as CityConfig;

beforeEach(() => {
  localStorage.clear();
  showSetupShell.mockClear();
  deviceCities.records = [];
  deviceCities.live = new Set();
  deviceCities.listCalls = 0;
  deviceCities.liveCalls = [];
});

async function completeSetup() {
  const { writeOnboardingRecord, newInstallRecord } = await import("../services/onboardingRecord.ts");
  writeOnboardingRecord({ ...newInstallRecord({ kind: "existing" }), applied: true });
}
afterEach(() => vi.unstubAllGlobals());

describe("startup gate", () => {
  it("reads the stored city and the deep link", async () => {
    const { pendingDeepLink, restoredCityId } = await import("./startupGate.ts");
    localStorage.setItem("ptn-city", JSON.stringify({ state: { activeCity: { id: "riga" } }, version: 0 }));
    expect(restoredCityId([city("riga")])).toBe("riga");
    expect(restoredCityId([city("vilnius")])).toBeNull();
    localStorage.setItem("ptn-city", "{broken");
    expect(restoredCityId([city("riga")])).toBeNull();
    expect(pendingDeepLink({ pathname: "/", search: "" })).toBeNull();
    expect(pendingDeepLink({ pathname: "/search", search: "?toStopId=1" })).toBe("/search?toStopId=1");
  });

  it("shows setup on a fresh profile", async () => {
    const { runStartupGate } = await import("./startupGate.ts");
    await runStartupGate({ cities: [city("vilnius")], catalogWasCached: false });
    expect(showSetupShell).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "full", catalogStatus: "fresh", storageAvailable: true }),
    );
  });

  it("falls back to cities on this device when the catalog fails", async () => {
    deviceCities.records = [{ cityId: "riga", city: city("riga"), sizeBytes: 5 }];
    const { runStartupGate } = await import("./startupGate.ts");
    await runStartupGate({ cities: [], catalogWasCached: false });
    expect(showSetupShell).toHaveBeenCalledWith(
      expect.objectContaining({ catalogStatus: "device-only", cities: [city("riga")] }),
    );
  });

  it("offers a retry when neither the catalog nor city data is available", async () => {
    const { runStartupGate } = await import("./startupGate.ts");
    await runStartupGate({ cities: [], catalogWasCached: false });
    expect(showSetupShell).toHaveBeenCalledWith(expect.objectContaining({ catalogStatus: "failed", cities: [] }));
  });

  it("enters directly after setup, offline included, when the city's data is on this device", async () => {
    const { writeOnboardingRecord, newInstallRecord } = await import("../services/onboardingRecord.ts");
    writeOnboardingRecord({ ...newInstallRecord({ kind: "existing" }), applied: true });
    localStorage.setItem("ptn-city", JSON.stringify({ state: { activeCity: { id: "riga" } }, version: 0 }));
    deviceCities.live = new Set(["riga"]);
    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    const { runStartupGate } = await import("./startupGate.ts");
    await runStartupGate({ cities: [city("vilnius"), city("riga")], catalogWasCached: true });
    expect(showSetupShell).not.toHaveBeenCalled();
    const { useCityStore } = await import("../stores/cityStore.ts");
    expect(useCityStore.getState().activeCity.id).toBe("riga");
  });

  it("reads the id-only stored city and historical aliases", async () => {
    const { restoredCityId } = await import("./startupGate.ts");
    localStorage.setItem("ptn-city", JSON.stringify({ state: { currentCityId: "riga" } }));
    expect(restoredCityId([city("riga")])).toBe("riga");
    localStorage.setItem("ptn-city", JSON.stringify({ state: { activeCity: { id: "gdansk" } } }));
    expect(restoredCityId([city("vilnius"), city("tricity")])).toBe("tricity");
    expect(restoredCityId([city("vilnius")])).toBeNull();
  });

  it("enters an online returning rider's city without reading downloaded or live city data", async () => {
    await completeSetup();
    localStorage.setItem("ptn-city", JSON.stringify({ state: { currentCityId: "riga" } }));
    const { runStartupGate } = await import("./startupGate.ts");
    await runStartupGate({ cities: [city("vilnius"), city("riga")], catalogWasCached: true });
    expect(showSetupShell).not.toHaveBeenCalled();
    expect(deviceCities.listCalls).toBe(0);
    expect(deviceCities.liveCalls).toEqual([]);
    const { useCityStore } = await import("../stores/cityStore.ts");
    expect(useCityStore.getState().activeCity.id).toBe("riga");
  });

  it("offline, checks only the stored city before entering it", async () => {
    await completeSetup();
    localStorage.setItem("ptn-city", JSON.stringify({ state: { currentCityId: "riga" } }));
    deviceCities.live = new Set(["riga"]);
    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    const { runStartupGate } = await import("./startupGate.ts");
    await runStartupGate({ cities: [city("vilnius"), city("riga")], catalogWasCached: true });
    expect(showSetupShell).not.toHaveBeenCalled();
    expect(deviceCities.listCalls).toBe(1);
    expect(deviceCities.liveCalls).toEqual(["riga"]);
  });
});
