import { describe, expect, it } from "vitest";
import type { Alert } from "@pt/shared";
import {
  cityDayBounds,
  isAlertActiveAt,
  isAlertActiveOnCityDay,
  matchAlert,
  matchSelector,
  pickTranslation,
  selectAlerts,
} from "./serviceAlertSelection.ts";

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "a1",
    cause: "UNKNOWN_CAUSE",
    effect: "DETOUR",
    severity: "WARNING",
    header: [{ text: "Detour" }],
    description: [],
    url: [],
    activePeriods: [],
    informedEntities: [{ routeId: "R1" }],
    ...overrides,
  };
}

describe("selector matching", () => {
  it("ANDs the fields within a selector", () => {
    const selector = { routeId: "R1", stopId: "S1" };
    expect(matchSelector(selector, { routeId: "R1", stopId: "S1" })).toBe("direct");
    expect(matchSelector(selector, { routeId: "R1", stopId: "S2" })).toBeNull();
    expect(matchSelector(selector, { routeId: "R2", stopId: "S1" })).toBeNull();
  });

  it("reports a partial match when the target lacks a named field", () => {
    // Route X at stop Y, seen from route X's line view.
    expect(matchSelector({ routeId: "R1", stopId: "S1" }, { routeId: "R1" })).toBe(
      "partial",
    );
    // Nothing the target knows was compared.
    expect(matchSelector({ routeId: "R1" }, { stopId: "S1" })).toBeNull();
  });

  it("matches every selector field, including numeric ones", () => {
    const target = {
      agencyId: "A",
      routeId: "R1",
      routeType: 3,
      directionId: 1,
      tripId: "T1",
      stopId: "S1",
    };
    expect(matchSelector({ agencyId: "A" }, target)).toBe("direct");
    expect(matchSelector({ routeType: 3 }, target)).toBe("direct");
    expect(matchSelector({ routeType: 0 }, target)).toBeNull();
    expect(matchSelector({ routeId: "R1", directionId: 0 }, target)).toBeNull();
    expect(matchSelector({ tripId: "T1" }, target)).toBe("direct");
  });

  it("never matches an empty selector", () => {
    expect(matchSelector({}, { routeId: "R1" })).toBeNull();
  });

  it("ORs the selectors of an alert, strongest match winning", () => {
    const a = alert({
      informedEntities: [{ routeId: "R1", stopId: "S9" }, { stopId: "S1" }],
    });
    expect(matchAlert(a, { stopId: "S1" })).toBe("direct");
    expect(matchAlert(a, { routeId: "R1" })).toBe("partial");
    expect(matchAlert(a, { routeId: "R2" })).toBeNull();
  });

  it("selects alerts for any target, once each, in response order", () => {
    const a = alert({ id: "a", informedEntities: [{ stopId: "S1" }] });
    const b = alert({ id: "b", informedEntities: [{ routeId: "R1", stopId: "S2" }] });
    const c = alert({ id: "c", informedEntities: [{ routeId: "R9" }] });
    const targets = [{ stopId: "S1" }, { stopId: "S1", routeId: "R1" }, { routeId: "R1" }];
    expect(selectAlerts([a, b, c], targets).map((x) => x.id)).toEqual(["a"]);
    expect(
      selectAlerts([a, b, c], targets, { includePartial: true }).map((x) => x.id),
    ).toEqual(["a", "b"]);
  });

  it("filters by activity when asked", () => {
    const ended = alert({
      id: "ended",
      activePeriods: [{ end: "2026-01-01T00:00:00Z" }],
    });
    const now = Date.parse("2026-06-01T00:00:00Z");
    expect(selectAlerts([ended], [{ routeId: "R1" }], { activeAt: now })).toEqual([]);
    expect(selectAlerts([ended], [{ routeId: "R1" }])).toHaveLength(1);
  });
});

describe("active periods", () => {
  it("treats no periods as always active and open bounds as unbounded", () => {
    expect(isAlertActiveAt(alert(), 0)).toBe(true);
    const fromJune = alert({ activePeriods: [{ start: "2026-06-01T00:00:00Z" }] });
    expect(isAlertActiveAt(fromJune, Date.parse("2026-05-31T23:59:59Z"))).toBe(false);
    expect(isAlertActiveAt(fromJune, Date.parse("2030-01-01T00:00:00Z"))).toBe(true);
  });

  it("is active when any period contains the instant", () => {
    const a = alert({
      activePeriods: [
        { start: "2026-06-01T06:00:00Z", end: "2026-06-01T08:00:00Z" },
        { start: "2026-06-02T06:00:00Z", end: "2026-06-02T08:00:00Z" },
      ],
    });
    expect(isAlertActiveAt(a, Date.parse("2026-06-02T07:00:00Z"))).toBe(true);
    expect(isAlertActiveAt(a, Date.parse("2026-06-01T12:00:00Z"))).toBe(false);
    expect(isAlertActiveAt(a, Date.parse("2026-06-01T08:00:00Z"))).toBe(true);
  });

  it("evaluates a day in the city's time zone, across midnight", () => {
    // 23:30-00:30 Vilnius time (UTC+3 in summer) on the night of June 1.
    const a = alert({
      activePeriods: [{ start: "2026-06-01T20:30:00Z", end: "2026-06-01T21:30:00Z" }],
    });
    expect(isAlertActiveOnCityDay(a, 20260601, "Europe/Vilnius")).toBe(true);
    expect(isAlertActiveOnCityDay(a, 20260602, "Europe/Vilnius")).toBe(true);
    expect(isAlertActiveOnCityDay(a, 20260603, "Europe/Vilnius")).toBe(false);
    // Same instants are a single afternoon in New York.
    expect(isAlertActiveOnCityDay(a, 20260602, "America/New_York")).toBe(false);
  });

  it("uses 23- and 25-hour days on DST transitions", () => {
    const [springStart, springEnd] = cityDayBounds(20260329, "Europe/Vilnius");
    expect(springEnd - springStart).toBe(23 * 3600_000);
    const [fallStart, fallEnd] = cityDayBounds(20261025, "Europe/Vilnius");
    expect(fallEnd - fallStart).toBe(25 * 3600_000);

    // Active only during the extra hour at the end of the long day's span:
    // 23:30 local on Oct 25 (UTC+2) is 21:30Z.
    const lateOnFallDay = alert({
      activePeriods: [{ start: "2026-10-25T21:30:00Z", end: "2026-10-25T21:45:00Z" }],
    });
    expect(isAlertActiveOnCityDay(lateOnFallDay, 20261025, "Europe/Vilnius")).toBe(true);
    expect(isAlertActiveOnCityDay(lateOnFallDay, 20261026, "Europe/Vilnius")).toBe(false);
  });
});

describe("translation choice", () => {
  const text = [
    { language: "en", text: "Detour" },
    { language: "lt-LT", text: "Apvažiavimas" },
    { text: "Default" },
    { language: "pl", text: "" },
  ];

  it("prefers the UI locale, then the same language", () => {
    expect(pickTranslation(text, "en")?.text).toBe("Detour");
    expect(pickTranslation(text, "lt")?.text).toBe("Apvažiavimas");
    expect(pickTranslation(text, "EN-gb")?.text).toBe("Detour");
  });

  it("falls back to the untagged text, then the first entry, skipping empty text", () => {
    expect(pickTranslation(text, "pl")?.text).toBe("Default");
    expect(pickTranslation([{ language: "de", text: "Umleitung" }], "pl")).toEqual({
      language: "de",
      text: "Umleitung",
    });
    expect(pickTranslation([], "en")).toBeUndefined();
  });
});
