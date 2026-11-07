import { describe, expect, it } from "vitest";
import type { CityConfig } from "../config/cities.ts";
import { newInstallRecord, type OnboardingRecord } from "../services/onboardingRecord.ts";
import { isCityOpenable, planStartup, type StartupInput } from "./startupPlan.ts";

const city = (id: string, available = true): CityConfig =>
  ({
    id,
    name: id,
    tz: "Europe/Vilnius",
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

  it("treats cities without transit data as openable only when installed", () => {
    expect(isCityOpenable(city("tallinn", false), new Set(), false)).toBe(false);
    expect(isCityOpenable(city("tallinn", false), new Set(["tallinn"]), true)).toBe(true);
    expect(isCityOpenable(city("riga"), new Set(), true)).toBe(false);
  });
});
