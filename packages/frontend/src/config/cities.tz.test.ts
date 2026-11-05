/**
 * Build-time guard: every shipped city MUST declare a valid IANA `tz`
 * matching the feed's agency_timezone. A typo or omission here silently
 * mis-displays times for cross-tz users (and trips the load-time drift check),
 * so we assert it at PR time for ALL cities. Expected values are pinned so a
 * fat-fingered edit (e.g. Krakow → Europe/Paris) fails here.
 */
import { describe, expect, it } from "vitest";
import { CITIES } from "./cities.ts";

const EXPECTED_TZ: Record<string, string> = {
  vilnius: "Europe/Vilnius",
  tricity: "Europe/Warsaw",
  krakow: "Europe/Warsaw",
  paris: "Europe/Paris",
  oslo: "Europe/Oslo",
  tbilisi: "Asia/Tbilisi",
};

describe("CityConfig.tz", () => {
  it("every shipped city declares the expected IANA zone", () => {
    for (const c of CITIES) {
      expect(c.tz, `city ${c.id} must declare tz`).toBe(EXPECTED_TZ[c.id]);
    }
  });

  it("every tz is a resolvable IANA zone", () => {
    for (const c of CITIES) {
      expect(() =>
        new Intl.DateTimeFormat("en-US", { timeZone: c.tz }),
      ).not.toThrow();
    }
  });
});
