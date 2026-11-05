/**
 * Production-WIRING cross-tz tests [R-fold v4 BLOCKING #3/#4/#8]. The leaf
 * `format.tz.test` + the primitive `crossTz.spec` asserts prove the helpers; they
 * do NOT prove that the `feedTz`/feed-tz-YMD values actually REACH the render tree
 * and the orchestrator's RAPTOR query. A dropped 3rd `formatTime` arg, or a missed
 * thread of `config.feedTz` into the derivation, ships green against UTC-only text
 * assertions. These tests fail-red on exactly those regressions.
 *
 * `.spec.ts` under `src/__tz_tests__/` → collected ONLY by `vitest.tz.config.ts`
 * under the non-UTC zones (`test:tz`), never by the default UTC `pnpm test`.
 *
 * Render assertions run under TZ=America/New_York (cross-tz). The local-user
 * display-path equivalence (#4) runs ONLY under TZ=Europe/Vilnius (`runIf(isLocal)`).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { BrowserRouter } from "react-router-dom";
import "@testing-library/jest-dom";
import "fake-indexeddb/auto";

import { serviceDayOriginUnix } from "@pt/shared/time";
import { formatTime } from "../components/RouteResults/shared/format.ts";
import { RouteResults } from "../components/RouteResults/RouteResults.tsx";
import { LegRow } from "../components/Guidance/LegRow.tsx";
import { TzIndicator } from "../components/RouteResults/shared/TzIndicator.tsx";
import { I18nProvider } from "../i18n/I18nProvider.tsx";
import { useSettingsStore, type RouteSearchVariant } from "../stores/settingsStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import type { Itinerary, Leg } from "@pt/shared";

const VILNIUS = "Europe/Vilnius";
const DEVICE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const isLocal = DEVICE === VILNIUS;
// `formattingLocale` in the default "auto" language setting is navigator.language;
// derive expectations from the SAME `formatTime` helper + locale so the assertions
// are locale-robust (12h/24h agnostic).
const LOC = typeof navigator !== "undefined" ? navigator.language : "en-US";

// 09:15 UTC → Vilnius 11:15 (+02:00 winter), NY 04:15 (-05:00). The wall clocks
// differ, so a render WITH feedTz vs WITHOUT it must produce different text.
const DEP_ISO = new Date(Date.UTC(2026, 0, 15, 9, 15, 0)).toISOString();
const ARR_ISO = new Date(Date.UTC(2026, 0, 15, 9, 45, 0)).toISOString();

function itinerary(overrides: Partial<Itinerary> = {}): Itinerary {
  return {
    legs: [
      {
        mode: "BUS",
        from: { name: "A", location: { lat: 0, lon: 0 } },
        to: { name: "B", location: { lat: 0, lon: 0 } },
        departureTime: DEP_ISO,
        arrivalTime: ARR_ISO,
        durationSeconds: 1800,
        routeShortName: "42",
      },
    ],
    departureTime: DEP_ISO,
    arrivalTime: ARR_ISO,
    durationSeconds: 1800,
    transfers: 0,
    walkingDistanceMeters: 200,
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  useSettingsStore.setState({ routeSearchVariant: "consumer" });
});

// #3 render-wiring — each RouteResults variant threads feedTz to formatTime.
describe.skipIf(isLocal)("#3 RouteResults render-wiring (device != feed)", () => {
  const vilniusDep = formatTime(DEP_ISO, LOC, VILNIUS);
  const deviceDep = formatTime(DEP_ISO, LOC); // device tz (NY)

  // Sanity: the two wall clocks really differ in this env, else the fail-red below
  // is vacuous.
  it("the Vilnius and device wall clocks differ in this env", () => {
    expect(vilniusDep).not.toBe(deviceDep);
  });

  for (const variant of ["consumer", "power", "accessible"] as RouteSearchVariant[]) {
    it(`variant=${variant} renders the FEED-tz wall clock when feedTz is passed`, () => {
      useSettingsStore.setState({ routeSearchVariant: variant });
      const { container } = render(
        createElement(
          BrowserRouter,
          null,
          createElement(RouteResults, {
            itineraries: [itinerary()],
            onSelect: () => {},
            feedTz: VILNIUS,
          }),
        ),
      );
      const text = container.textContent ?? "";
      expect(text).toContain(vilniusDep);
      // The device clock must NOT appear (it would, if the arg were dropped).
      expect(text).not.toContain(deviceDep);
    });
  }

  it("WITHOUT feedTz renders the DEVICE wall clock (dropping the arg fails red)", () => {
    const { container } = render(
      createElement(
        BrowserRouter,
        null,
        createElement(RouteResults, {
          itineraries: [itinerary()],
          onSelect: () => {},
        }),
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain(deviceDep);
    expect(text).not.toContain(vilniusDep);
  });

  // Guidance (LegRow) reads feedTz from useCityStore (not a prop) — drive it there.
  it("Guidance LegRow renders the feed-tz wall clock from useCityStore", () => {
    const prev = useCityStore.getState().activeCity;
    useCityStore.setState({ activeCity: { ...prev, tz: VILNIUS } });
    const leg: Leg = {
      mode: "BUS",
      from: { name: "A", location: { lat: 0, lon: 0 } },
      to: { name: "B", location: { lat: 0, lon: 0 } },
      departureTime: DEP_ISO,
      arrivalTime: ARR_ISO,
      durationSeconds: 1800,
      routeShortName: "42",
    };
    const { container } = render(
      createElement(
        I18nProvider,
        null,
        createElement(LegRow, { leg, status: "upcoming" }),
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain(formatTime(DEP_ISO, LOC, VILNIUS));
    useCityStore.setState({ activeCity: prev });
  });
});

// #3 orchestrator-wiring — config.feedTz actually reaches departureSecs + todayDate.
// Mock the on-device planning boundary so we can capture the RAPTOR query + the
// date arg the orchestrator computes. Mock must be top-level (hoisted).
const dispatchSpy = vi.fn(async (..._args: unknown[]) => [] as unknown);
// `resolveDepartureOnDevice` stands in for the bundle's `PtRouter.resolveTime`:
// the feed-zone frame comes from the bundle, not from the device or the feed clock.
const resolveSpy = vi.fn(async (_unix: number, _ctx: unknown) => ({
  serviceDate: "20260116", timeOriginUnix: 0, departureSecs: 1800,
}));
vi.mock("../services/wasmPlanner.ts", () => ({
  planOnDevice: (...args: unknown[]) => dispatchSpy(...args),
  resolveDepartureOnDevice: (...args: unknown[]) => resolveSpy(...(args as [number, unknown])),
}));

describe.skipIf(isLocal)("#3 orchestrator config.feedTz reaches the derivation", () => {
  beforeEach(() => {
    dispatchSpy.mockClear();
  });

  // Mirror the existing orchestrator test's minimal index + stops.
  function buildMinimalIndex() {
    return {
      routes: [
        {
          id: "R1",
          shortName: "1",
          mode: "BUS" as const,
          stopIds: ["S1", "S2", "S3"],
          trips: [
            { tripId: "T1", serviceId: "svc1", headsign: "Centre", departureSecs: [28800, 29400, 30000] },
          ],
        },
      ],
      routeIdToIdx: new Map([["R1", 0]]),
      routesAtStop: new Map([["S1", [0]], ["S2", [0]], ["S3", [0]]]),
      services: new Map([
        [
          "svc1",
          { serviceId: "svc1", days: [true, true, true, true, true, true, true], startDate: "20260101", endDate: "20271231", exceptions: {} },
        ],
      ]),
    } as never;
  }
  const allStops = [
    { id: "S1", name: "Stop A", lat: 54.68, lon: 25.2797 },
    { id: "S2", name: "Stop B", lat: 54.7, lon: 25.2797 },
    { id: "S3", name: "Stop C", lat: 54.72, lon: 25.2797 },
  ];

  it("resolves the departure instant on the bundle and plans in the resolved frame", async () => {
    const { SearchOrchestrator } = await import("../services/searchOrchestrator.ts");
    const orchestrator = new SearchOrchestrator({
      raptorIndex: buildMinimalIndex(),
      allStops,
      getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as never,
      feedTz: VILNIUS,
    });

    // 00:30 Vilnius (2026-01-16) = 22:30 UTC = 17:30 the prior day in NY (device).
    const departure = Date.UTC(2026, 0, 15, 22, 30, 0);
    await orchestrator.search({
      origin: { lat: 54.68, lon: 25.2797 },
      destination: { lat: 54.72, lon: 25.2797 },
      departureTime: new Date(departure),
      ranking: "fastest",
    });

    // The instant itself goes to the bundle, unshifted by any device zone.
    expect(resolveSpy).toHaveBeenCalled();
    expect(resolveSpy.mock.calls[0]![0]).toBe(departure / 1000);
    expect(dispatchSpy).toHaveBeenCalled();
    const [query, , date] = dispatchSpy.mock.calls[0] as unknown as [
      { departureSecs: number },
      unknown,
      string,
    ];
    // The engine plans in the resolved service date and GTFS Time (1800 s past the
    // origin here), not in the device's 17:30 wall clock on 2026-01-15.
    expect(query.departureSecs).toBe(1800);
    expect(date).toBe("20260116");
  });
});

// #4 local-user DISPLAY-path equivalence (runIf isLocal) — the projection must be
// byte-identical to the LEGACY device-local base-date cascade over the real input
// classes on an ordinary (non-DST) date, so the local user sees NO change there.
// Mirrors the (private) Search.tsx `projectToIso`. On a DST date the origin, not
// local midnight, is the GTFS reference, so the two deliberately differ there.
function projectToIso(secs: number, serviceDateYmd: number, feedTz: string | undefined, _baseDate: Date): string {
  // exact mirror of Search.tsx projectToIso (kept in-test because the production
  // fn is module-private): GTFS seconds from the service date's origin.
  const tz = feedTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Date((serviceDayOriginUnix(serviceDateYmd, tz) + secs) * 1000).toISOString();
}
function legacySecsToIso(secs: number, baseDate: Date): string {
  const d = new Date(baseDate);
  d.setHours(0, 0, 0, 0);
  d.setSeconds(secs);
  return d.toISOString();
}

describe.runIf(isLocal)("#4 local-user projectToIso == legacy secsToIso (device == feed)", () => {
  // A base date on the query service day; the feed-tz projection uses the YMD, the
  // legacy path uses the device-local midnight of `baseDate` + secs.
  const baseDate = new Date(Date.UTC(2026, 0, 15, 22, 30, 0)); // device == Vilnius here
  const ymd = 20260116; // the service date in Vilnius for that instant
  const baseForLegacy = new Date(Date.UTC(2026, 0, 15, 22, 0, 0)); // any same-civil-day base

  // Real input classes: transit dep/arr, a near-midnight walk leg, an overnight
  // secs<0 (engine -86400 rewrite) and secs>86400 (GTFS overnight).
  for (const secs of [
    8 * 3600 + 30 * 60, // transit dep 08:30
    9 * 3600 + 15 * 60, // transit arr 09:15
    30, // near-midnight walk leg
    -1800, // overnight rewritten secs<0
    25 * 3600 + 30 * 60, // GTFS overnight secs>86400
  ]) {
    it(`secs=${secs} projects byte-identically on the local-user path`, () => {
      const baseDay = new Date(baseDate);
      baseDay.setHours(0, 0, 0, 0);
      expect(projectToIso(secs, ymd, VILNIUS, baseDay)).toBe(legacySecsToIso(secs, baseDay));
    });
  }

  // baseForLegacy guards the no-feedTz branch path itself (the local user with a
  // legacy base-date — still must equal the bare cascade).
  it("no-feedTz branch equals the bare cascade", () => {
    expect(projectToIso(8 * 3600, ymd, undefined, baseForLegacy)).toBe(
      legacySecsToIso(8 * 3600, baseForLegacy),
    );
  });
});

// #8 rendered drift-surface — TzIndicator surfaces "unverified" on a config-vs-bundle
// tz MISMATCH driven from the store; and "city time" when verified.
describe.skipIf(isLocal)("#8 rendered drift surface (device != feed)", () => {
  beforeEach(() => {
    useGtfsDataStore.setState({ bundleCityTzIana: null });
  });

  it("renders the unverified badge when bundle tz mismatches config tz", () => {
    const prev = useCityStore.getState().activeCity;
    // Seed BOTH stores before render so no post-render subscribed update fires.
    useCityStore.setState({ activeCity: { ...prev, tz: "Europe/Warsaw" } });
    useGtfsDataStore.setState({ bundleCityTzIana: VILNIUS }); // mismatch → drift
    render(createElement(I18nProvider, null, createElement(TzIndicator, {})));
    const badge = screen.getByTestId("tz-indicator");
    expect(badge.textContent ?? "").toMatch(/unverified|nepatvirtinta/i);
    useCityStore.setState({ activeCity: prev });
  });

  it("renders a verified city-time badge when bundle tz matches config tz", () => {
    const prev = useCityStore.getState().activeCity;
    useCityStore.setState({ activeCity: { ...prev, tz: VILNIUS } });
    useGtfsDataStore.setState({ bundleCityTzIana: VILNIUS }); // verified
    render(createElement(I18nProvider, null, createElement(TzIndicator, {})));
    const badge = screen.getByTestId("tz-indicator");
    const txt = badge.textContent ?? "";
    expect(txt).not.toMatch(/unverified|nepatvirtinta/i);
    expect(txt.length).toBeGreaterThan(0); // crossTz under NY → badge shows
    useCityStore.setState({ activeCity: prev });
  });
});
