/**
 * Decide, before any app module loads, whether the app can start directly or
 * the setup shell has to run first. Pure: the caller gathers the inputs.
 */
import type { CityConfig } from "../config/cities.ts";
import {
  isSetupComplete,
  type OnboardingRecord,
} from "../services/onboardingRecord.ts";

export interface StartupInput {
  readonly cities: readonly CityConfig[];
  /** `null` when the record is missing, corrupt or unreadable. */
  readonly record: OnboardingRecord | null;
  /** The stored city choice (`ptn-city`), if it names a catalog city. */
  readonly savedCityId: string | null;
  /** Cities whose transit data is on this device (downloaded or cached). */
  readonly installedCityIds: ReadonlySet<string>;
  readonly offline: boolean;
}

export type SetupMode =
  /** First run: city, then presentation and privacy. */
  | "full"
  /** Setup is done, but no usable city is selected. */
  | "city-only";

export type StartupPlan =
  | { readonly kind: "enter"; readonly cityId: string }
  | {
      readonly kind: "setup";
      readonly mode: SetupMode;
      readonly initialStep: "city" | "quick";
      readonly preselectedCityId: string | null;
    };

/** A city can be opened when the catalog lists it and, offline, when its
 * transit data is already on this device. */
export function isCityOpenable(
  city: CityConfig,
  installedCityIds: ReadonlySet<string>,
  offline: boolean,
): boolean {
  if (installedCityIds.has(city.id)) return true;
  return !offline && city.available !== false;
}

export function planStartup(input: StartupInput): StartupPlan {
  const byId = (id: string | null | undefined) =>
    id ? input.cities.find((city) => city.id === id) : undefined;
  const openable = (city: CityConfig | undefined) =>
    !!city && isCityOpenable(city, input.installedCityIds, input.offline);

  const saved = byId(input.savedCityId);
  if (isSetupComplete(input.record)) {
    if (saved && openable(saved)) return { kind: "enter", cityId: saved.id };
    return {
      kind: "setup",
      mode: "city-only",
      initialStep: "city",
      preselectedCityId: saved?.id ?? null,
    };
  }

  // A stored city (from an earlier version, a reload mid-setup, or data kept
  // through deletion) is preselected; setup still runs.
  const preselected =
    saved ?? byId(input.record?.install.preselectedCityId);
  return {
    kind: "setup",
    mode: "full",
    initialStep: preselected && openable(preselected) ? "quick" : "city",
    preselectedCityId: preselected?.id ?? null,
  };
}
