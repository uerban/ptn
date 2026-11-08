/**
 * Startup gate: runs after the installation is classified and the city
 * catalog is known, and before `appMain` (and with it every optional startup
 * task) is imported. A completed setup with an openable city enters the app
 * directly; otherwise the setup shell runs first.
 */
import { installCityCatalog, type CityConfig } from "../config/cities.ts";
import { readOnboardingRecord } from "../services/onboardingRecord.ts";
import type { CatalogStatus } from "../components/Onboarding/CitySelection.tsx";
import { deviceTimeZone, planStartup } from "./startupPlan.ts";

export interface StartupGateInput {
  /** The host's catalog; empty when discovery failed without a cached copy. */
  readonly cities: readonly CityConfig[];
  readonly catalogWasCached: boolean;
}

interface DeviceCityRecord {
  readonly cityId: string;
  /** Absent on downloads from before download details were listed separately. */
  readonly city?: CityConfig;
  readonly sizeBytes?: number;
}

interface DeviceCities {
  readonly records: readonly DeviceCityRecord[];
  readonly installed: ReadonlySet<string>;
  /** False when probing stopped at the first city. */
  readonly complete: boolean;
}

async function prepareDb(): Promise<void> {
  try {
    const { ensureDbReady } = await import("../db/migrationRunner.ts");
    await ensureDbReady();
    const { ensureDataSchemaUpToDate } = await import("../db/dataSchemaVersion.ts");
    await ensureDataSchemaUpToDate();
  } catch {
    // IndexedDB unavailable: reading device cities below finds none.
  }
}

/**
 * Cities with data on this device. `firstCityId` is probed before the others,
 * and when its data is present (`stopAtFirst`) the remaining cities are not
 * probed at all.
 */
async function readDeviceCities(
  cities: readonly CityConfig[],
  firstCityId: string | null = null,
  stopAtFirst = false,
): Promise<DeviceCities> {
  try {
    const { listDeviceCities, hasLiveDeviceCity } = await import("../services/deviceCities.ts");
    const records = await listDeviceCities();
    const installed = new Set(records.map((record) => record.cityId));
    if (firstCityId && (installed.has(firstCityId) || await hasLiveDeviceCity(firstCityId))) {
      installed.add(firstCityId);
      if (stopAtFirst) return { records, installed, complete: false };
    }
    for (const city of cities) {
      if (city.id !== firstCityId && await hasLiveDeviceCity(city.id)) installed.add(city.id);
    }
    return { records, installed, complete: true };
  } catch {
    // IndexedDB unavailable: no city data on this device.
    return { records: [], installed: new Set(), complete: true };
  }
}

/**
 * City configurations of downloaded cities. Older downloads list only their
 * id; their configuration is read from the download itself.
 */
async function deviceCityConfigs(records: readonly DeviceCityRecord[]): Promise<CityConfig[]> {
  const out: CityConfig[] = [];
  for (const record of records) {
    if (record.city) {
      out.push(record.city);
      continue;
    }
    try {
      const { db } = await import("../db/index.ts");
      const legacy = await db.offlineCities.get(record.cityId);
      if (legacy?.city) out.push(legacy.city);
    } catch {
      // Unreadable download: it cannot be opened without the catalog.
    }
  }
  return out;
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
    // Current stores keep only the id; older ones kept the whole city.
    const rawId: unknown = saved?.state?.currentCityId ?? saved?.state?.activeCity?.id;
    const id = rawId === "gdansk" ? "tricity" : rawId;
    return typeof id === "string" && cities.some((city) => city.id === id) ? id : null;
  } catch {
    return null;
  }
}

/** A deep link the user opened, or `null` for the home screen. */
export function pendingDeepLink(loc: Pick<Location, "pathname" | "search">): string | null {
  return loc.pathname === "/" && !loc.search ? null : `${loc.pathname}${loc.search}`;
}

async function enterCity(cities: readonly CityConfig[], cityId: string): Promise<void> {
  const { useCityStore } = await import("../stores/cityStore.ts");
  useCityStore.getState().setActiveCity(cities.find((city) => city.id === cityId)!);
}

export async function runStartupGate(input: StartupGateInput): Promise<void> {
  await prepareDb();
  const read = readOnboardingRecord();
  const offline = navigator.onLine === false;
  const record = read.status === "ok" ? read.record : null;

  // A returning rider with a usable city enters without enumerating downloads
  // or cloning live city data: online, any available catalog city opens;
  // offline, only the stored city is checked.
  const savedCityId = input.cities.length ? restoredCityId(input.cities) : null;
  let quick: DeviceCities | null = null;
  if (savedCityId) {
    if (offline) quick = await readDeviceCities(input.cities, savedCityId, true);
    const plan = planStartup({
      cities: input.cities,
      record,
      savedCityId,
      installedCityIds: quick?.installed ?? new Set<string>(),
      offline,
    });
    if (plan.kind === "enter") return enterCity(input.cities, plan.cityId);
  }

  const device = quick?.complete ? quick : await readDeviceCities(input.cities, savedCityId);
  let cities = input.cities;
  let catalogStatus: CatalogStatus = input.catalogWasCached ? "cached" : "fresh";
  if (!cities.length) {
    // Discovery failed with nothing cached: cities with data on this device
    // can still be opened.
    cities = await deviceCityConfigs(device.records);
    catalogStatus = cities.length ? "device-only" : "failed";
    if (cities.length) installCityCatalog(cities);
  }

  const plan = planStartup({
    cities,
    record,
    savedCityId: restoredCityId(cities),
    installedCityIds: device.installed,
    offline,
    timeZone: deviceTimeZone(),
  });

  if (plan.kind === "enter") return enterCity(cities, plan.cityId);

  const { showSetupShell } = await import("../components/Onboarding/mountSetupShell.tsx");
  await showSetupShell({
    mode: plan.mode,
    initialStep: plan.initialStep,
    preselectedCityId: plan.preselectedCityId,
    suggestedCityId: plan.suggestedCityId ?? null,
    cities,
    downloadedSizes: new Map(
      device.records.flatMap((r) => (r.sizeBytes === undefined ? [] : [[r.cityId, r.sizeBytes] as const])),
    ),
    installedCityIds: device.installed,
    offline,
    catalogStatus,
    storageAvailable: read.status !== "unavailable",
    deepLink: pendingDeepLink(globalThis.location),
  });
}
