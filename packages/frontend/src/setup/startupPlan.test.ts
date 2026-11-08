import { describe, expect, it } from "vitest";
import type { CityConfig } from "../config/cities.ts";
import { newInstallRecord, type OnboardingRecord } from "../services/onboardingRecord.ts";
import {
  isCityOpenable,
  planStartup,
  suggestCityByTimeZone,
  type StartupInput,
} from "./startupPlan.ts";

const city = (id: string, available = true, tz = "Europe/Vilnius"): CityConfig =>
  ({
    id,
    name: id,
    tz,
    available,
    center: { lat: 0, lon: 0 },
    bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
  }) as CityConfig;

const cities = [city("vilnius"), city("riga"), city("tallinn", false)];
const fresh = newInstallRecord({ kind: "new", classifiedAt: 1 });
const done: OnboardingRecord = {
  ...fresh,
  decisions: { preset: "recommended", level: "standard", flows: {} },
  applied: true,
};
const existing: OnboardingRecord = newInstallRecord({ kind: "existing", classifiedAt: 1 });

function plan(overrides: Partial<StartupInput>) {
  return planStartup({
    cities,
    record: fresh,
    savedCityId: null,
    installedCityIds: new Set(),
    offline: false,
    ...overrides,
  });
}

describe("startup plan", () => {
  it("runs full setup on a new installation", () => {
    expect(plan({})).toEqual({ kind: "setup", mode: "full", initialStep: "city", preselectedCityId: null });
    expect(plan({ record: null }).kind).toBe("setup");
  });

  it("preselects a stored city and resumes at the second step", () => {
    expect(plan({ savedCityId: "riga" })).toMatchObject({ mode: "full", initialStep: "quick", preselectedCityId: "riga" });
    const classified = newInstallRecord({ kind: "new", classifiedAt: 1, preselectedCityId: "vilnius" });
    expect(plan({ record: classified })).toMatchObject({ initialStep: "quick", preselectedCityId: "vilnius" });
  });

  it("enters directly once setup is complete, and for existing installations", () => {
    expect(plan({ record: done, savedCityId: "vilnius" })).toEqual({ kind: "enter", cityId: "vilnius" });
    expect(plan({ record: existing, savedCityId: "riga" })).toEqual({ kind: "enter", cityId: "riga" });
  });

  it("launches an installed city offline, and asks only for a city otherwise", () => {
    const installed = new Set(["vilnius"]);
    expect(plan({ record: done, savedCityId: "vilnius", offline: true, installedCityIds: installed })).toEqual({
      kind: "enter",
      cityId: "vilnius",
    });
    expect(plan({ record: done, savedCityId: "riga", offline: true, installedCityIds: installed })).toEqual({
      kind: "setup",
      mode: "city-only",
      initialStep: "city",
      preselectedCityId: "riga",
    });
    expect(plan({ record: existing })).toMatchObject({ mode: "city-only" });
  });

  it("does not resume into a city that cannot be opened", () => {
    expect(plan({ savedCityId: "riga", offline: true })).toMatchObject({ initialStep: "city", preselectedCityId: "riga" });
    expect(plan({ savedCityId: "tallinn" })).toMatchObject({ initialStep: "city" });
  });

  it("starts at the second step when only one city can be opened", () => {
    const one = [city("vilnius"), city("tallinn", false)];
    expect(plan({ cities: one })).toEqual({
      kind: "setup",
      mode: "full",
      initialStep: "quick",
      preselectedCityId: "vilnius",
    });
    // Offline, only a city with data on this device counts.
    expect(plan({ offline: true, installedCityIds: new Set(["riga"]) })).toMatchObject({
      initialStep: "quick",
      preselectedCityId: "riga",
    });
    expect(plan({ offline: true })).toMatchObject({ initialStep: "city", preselectedCityId: null });
    // A stored city that cannot be opened gives way to the only one that can.
    expect(plan({ cities: one, savedCityId: "tallinn" })).toMatchObject({
      initialStep: "quick",
      preselectedCityId: "vilnius",
    });
    // A completed setup still asks rather than switching city by itself.
    expect(plan({ cities: one, record: done })).toMatchObject({ mode: "city-only", initialStep: "city" });
  });

  it("asks for a city when the catalog failed", () => {
    expect(plan({ cities: [] })).toEqual({
      kind: "setup",
      mode: "full",
      initialStep: "city",
      preselectedCityId: null,
    });
    expect(plan({ cities: [], timeZone: "Europe/Vilnius" })).not.toHaveProperty("suggestedCityId");
  });

  it("suggests the one openable city in the device's time zone, without choosing it", () => {
    const zoned = [
      city("vilnius", true, "Europe/Vilnius"),
      city("krakow", true, "Europe/Warsaw"),
      city("tricity", true, "Europe/Warsaw"),
      city("oslo", false, "Europe/Oslo"),
    ];
    expect(plan({ cities: zoned, timeZone: "Europe/Vilnius" })).toEqual({
      kind: "setup",
      mode: "full",
      initialStep: "city",
      preselectedCityId: null,
      suggestedCityId: "vilnius",
    });
    // Two matches, an unopenable match, no match or no time zone: no suggestion.
    for (const timeZone of ["Europe/Warsaw", "Europe/Oslo", "Asia/Tokyo", null]) {
      expect(plan({ cities: zoned, timeZone })).not.toHaveProperty("suggestedCityId");
    }
    // A known city wins over the time zone.
    expect(plan({ cities: zoned, savedCityId: "vilnius", offline: true, timeZone: "Europe/Vilnius" }))
      .not.toHaveProperty("suggestedCityId");
    expect(suggestCityByTimeZone(zoned, "Europe/Oslo", new Set(["oslo"]), true)?.id).toBe("oslo");
  });

  it("treats cities without transit data as openable only when installed", () => {
    expect(isCityOpenable(city("tallinn", false), new Set(), false)).toBe(false);
    expect(isCityOpenable(city("tallinn", false), new Set(["tallinn"]), true)).toBe(true);
    expect(isCityOpenable(city("riga"), new Set(), true)).toBe(false);
  });
});
