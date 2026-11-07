/**
 * Startup gate: runs after the installation is classified and the city
 * catalog is known, and before `appMain` (and with it every optional startup
 * task) is imported. A completed setup with an openable city enters the app
 * directly; otherwise the setup shell runs first.
 */
import { installCityCatalog, type CityConfig } from "../config/cities.ts";
import { readOnboardingRecord } from "../services/onboardingRecord.ts";
import type { CatalogStatus } from "../components/Onboarding/CitySelection.tsx";
import { planStartup } from "./startupPlan.ts";

export interface StartupGateInput {
  /** The host's catalog; empty when discovery failed without a cached copy. */
  readonly cities: readonly CityConfig[];
  readonly catalogWasCached: boolean;
}

interface DeviceCities {
  readonly records: readonly { readonly city: CityConfig; readonly sizeBytes: number }[];
  readonly installed: ReadonlySet<string>;
}

async function readDeviceCities(cities: readonly CityConfig[]): Promise<DeviceCities> {
  try {
    const { ensureDbReady } = await import("../db/migrationRunner.ts");
    await ensureDbReady();
    const { ensureDataSchemaUpToDate } = await import("../db/dataSchemaVersion.ts");
    await ensureDataSchemaUpToDate();
    const { listDeviceCities, hasLiveDeviceCity } = await import("../services/deviceCities.ts");
    const records = await listDeviceCities();
    const installed = new Set(records.map((record) => record.cityId));
    for (const city of cities) if (await hasLiveDeviceCity(city.id)) installed.add(city.id);
    return { records, installed };
  } catch {
    // IndexedDB unavailable: no city data on this device.
    return { records: [], installed: new Set() };
  }
}

/** The stored city choice, when it names a catalog city. */
export function restoredCityId(
  cities: readonly CityConfig[],
  storage: Pick<Storage, "getItem"> | undefined = (() => {
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  })(),
): string | null {
  try {
    const saved = JSON.parse(storage?.getItem("ptn-city") ?? "null");
    const id: unknown = saved?.state?.activeCity?.id;
    return typeof id === "string" && cities.some((city) => city.id === id) ? id : null;
  } catch {
    return null;
  }
}

/** A deep link the user opened, or `null` for the home screen. */
export function pendingDeepLink(loc: Pick<Location, "pathname" | "search">): string | null {
  return loc.pathname === "/" && !loc.search ? null : `${loc.pathname}${loc.search}`;
}

export async function runStartupGate(input: StartupGateInput): Promise<void> {
  const device = await readDeviceCities(input.cities);
  let cities = input.cities;
  let catalogStatus: CatalogStatus = input.catalogWasCached ? "cached" : "fresh";
  if (!cities.length) {
    // Discovery failed with nothing cached: cities with data on this device
    // can still be opened.
    cities = device.records.map((record) => record.city);
    catalogStatus = cities.length ? "device-only" : "failed";
    if (cities.length) installCityCatalog(cities);
  }

  const read = readOnboardingRecord();
  const offline = navigator.onLine === false;
  const plan = planStartup({
    cities,
    record: read.status === "ok" ? read.record : null,
    savedCityId: restoredCityId(cities),
    installedCityIds: device.installed,
    offline,
  });

  if (plan.kind === "enter") {
    const { useCityStore } = await import("../stores/cityStore.ts");
    useCityStore.getState().setActiveCity(cities.find((city) => city.id === plan.cityId)!);
    return;
  }

  const { showSetupShell } = await import("../components/Onboarding/mountSetupShell.tsx");
  await showSetupShell({
    mode: plan.mode,
    initialStep: plan.initialStep,
    preselectedCityId: plan.preselectedCityId,
    cities,
    downloadedSizes: new Map(device.records.map((r) => [r.city.id, r.sizeBytes])),
    installedCityIds: device.installed,
    offline,
    catalogStatus,
    storageAvailable: read.status !== "unavailable",
    deepLink: pendingDeepLink(globalThis.location),
  });
}
