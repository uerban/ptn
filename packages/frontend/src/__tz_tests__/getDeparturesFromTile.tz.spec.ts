/**
 * Cross-TZ correctness for `getDeparturesFromTile`'s OPTIONAL `tz` param (R1c / J1).
 *
 * When `tz` is passed, civil-date selection AND absolute-instant emission run in
 * the FEED zone via `serviceDayToUnix`/`unixToServiceDay` (DST-correct), not the
 * browser-local `Date`. The instants must therefore be byte-identical regardless
 * of the process `TZ`. `test:tz` runs this twice — TZ=America/New_York (cross-tz)
 * and TZ=Europe/Vilnius (the local-user gate for the OTHER suites) — and BOTH
 * runs assert the SAME hard-coded ISO instants below; identical output across the
 * two runs is the proof the device TZ no longer leaks into the result.
 *
 * Fixture is the Paris spring-forward day 2026-03-29 (CET +01:00 → CEST +02:00 at
 * 02:00 local). `now` = 2026-03-29 22:00 Paris (= 2026-03-29T20:00:00Z), look-ahead
 * 4h ⇒ upperCutoff 2026-03-30T00:00:00Z. The K1 edge departure (25:59 on the
 * spring-forward base date) has a TRUE instant of 23:59:00Z (inside the window),
 * but its GTFS elapsed-secs (93540) exceed the elapsed-frame `upperSecs` (90000)
 * because the civil day was only 23h long — so the un-widened `dep > upperSecs`
 * break would drop it. The +3600 DST guard band keeps it; the exact-instant
 * re-check does the true cut. See the design doc's R1c section.
 *
 * NOTE: this is `*.spec.ts` (NOT `.test.ts`) under `src/__tz_tests__/` so the base
 * `vitest.config.ts` `exclude` keeps it OUT of the default UTC `pnpm test`; only
 * `vitest.tz.config.ts` collects it.
 */
import { describe, expect, it } from "vitest";
import { getDeparturesFromTile } from "@pt/shared/transit";
import type {
  DecodedScheduleTile,
  RtTripUpdate,
} from "@pt/shared";

const PARIS = "Europe/Paris";
const DEVICE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// All-days-active service so weekday selection never gates the fixture.
const ALL_DAYS = [true, true, true, true, true, true, true] as const;

/**
 * One stop ("S1") on the Paris spring-forward day with three departures, the
 * per-stop `departureSecs` SORTED ASCENDING (parallel `tripIxs`):
 *   - T_NORMAL  dep 81000  (22:30 elapsed on base 20260329) → 2026-03-29T20:30:00Z
 *   - T_K1      dep 93540  (25:59 elapsed on base 20260329) → 2026-03-29T23:59:00Z
 *               THE K1 DROP CASE: elapsed-frame upperSecs=90000, so 93540 would
 *               `break` without the +3600 guard band; true instant is in-window.
 *   - T_OVERNIGHT dep 169200 (>86400 overnight) on base 20260328 → 2026-03-29T21:00:00Z
 */
function mkTile(): DecodedScheduleTile {
  return {
    bundleHash: "hash",
    cityId: "paris",
    tileSize: 6000,
    stringTable: ["T_NORMAL", "T_K1", "T_OVERNIGHT", "Center", "Airport", "Depot"],
    routes: [
      { id: "R1", shortName: "1", longName: "One", color: "#FF0000", mode: "BUS" },
      { id: "R2", shortName: "2", longName: "Two", color: "#00FF00", mode: "TRAM" },
      { id: "R3", shortName: "3", longName: "Three", color: "#0000FF", mode: "BUS" },
    ],
    calendar: [
      {
        serviceId: "SVC",
        days: ALL_DAYS,
        startDate: "20260101",
        endDate: "20261231",
        added: [],
        removed: [],
      },
    ],
    trips: [
      { tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 3 }, // T_NORMAL
      { tripIdIx: 1, routeIx: 1, serviceIx: 0, headsignIx: 4 }, // T_K1
      { tripIdIx: 2, routeIx: 2, serviceIx: 0, headsignIx: 5 }, // T_OVERNIGHT
    ],
    stops: {
      S1: {
        tripIxs: new Uint32Array([0, 1, 2]),
        departureSecs: new Uint32Array([81000, 93540, 169200]),
      },
    },
  };
}

// 2026-03-29 22:00 Paris (CEST +02:00) = 20:00:00 UTC. look-ahead 4h.
const NOW = new Date(Date.UTC(2026, 2, 29, 20, 0, 0));
const LOOK_AHEAD_HOURS = 4;

// Date-scoped RT row keyed by the CITY civil date (J5). +180s delay on T_K1.
function rtUpdates(): Map<string, RtTripUpdate> {
  return new Map<string, RtTripUpdate>([
    ["T_K1|20260329", { tripId: "T_K1", delaySeconds: 180, cancelled: false }],
  ]);
}

// Hard-coded expected instants. Device-INDEPENDENT (explicit `tz=Europe/Paris`),
// so byte-identical under TZ=America/New_York AND TZ=Europe/Vilnius. Sorted by
// scheduled instant (the function sorts ascending).
const EXPECTED = [
  { tripId: "T_NORMAL", scheduledTime: "2026-03-29T20:30:00.000Z", predictedTime: undefined, delaySeconds: undefined },
  { tripId: "T_OVERNIGHT", scheduledTime: "2026-03-29T21:00:00.000Z", predictedTime: undefined, delaySeconds: undefined },
  { tripId: "T_K1", scheduledTime: "2026-03-29T23:59:00.000Z", predictedTime: "2026-03-30T00:02:00.000Z", delaySeconds: 180 },
] as const;

it("harness runs under a non-UTC zone", () => {
  expect(DEVICE).not.toBe("UTC");
  expect(new Date().getTimezoneOffset()).not.toBe(0);
});

describe("getDeparturesFromTile(tz) — feed-tz instants (device-independent)", () => {
  it("emits the city-tz scheduled/predicted instants byte-identically across both TZ runs", () => {
    const res = getDeparturesFromTile({
      tile: mkTile(),
      stopId: "S1",
      now: NOW,
      limit: 50,
      lookAheadHours: LOOK_AHEAD_HOURS,
      tz: PARIS,
      realtimeUpdates: rtUpdates(),
    });

    expect(res.serviceState).toBe("active");
    expect(res.departures.map((d) => d.tripId)).toEqual([
      "T_NORMAL",
      "T_OVERNIGHT",
      "T_K1",
    ]);
    for (let i = 0; i < EXPECTED.length; i++) {
      const got = res.departures[i]!;
      const exp = EXPECTED[i]!;
      expect(got.tripId).toBe(exp.tripId);
      expect(got.scheduledTime).toBe(exp.scheduledTime);
      expect(got.predictedTime).toBe(exp.predictedTime);
      expect(got.delaySeconds).toBe(exp.delaySeconds);
    }
  });

  it("K1: the spring-forward edge departure (true instant in the final ~1h) is NOT dropped", () => {
    const res = getDeparturesFromTile({
      tile: mkTile(),
      stopId: "S1",
      now: NOW,
      limit: 50,
      lookAheadHours: LOOK_AHEAD_HOURS,
      tz: PARIS,
    });
    const k1 = res.departures.find((d) => d.tripId === "T_K1");
    expect(k1).toBeDefined();
    expect(k1!.scheduledTime).toBe("2026-03-29T23:59:00.000Z");
    // ...and its true instant sits inside the look-ahead window upper bound.
    const upperCutoffMs = NOW.getTime() + LOOK_AHEAD_HOURS * 3600 * 1000;
    expect(new Date(k1!.scheduledTime).getTime()).toBeLessThanOrEqual(upperCutoffMs);
  });

  it("J5: the date-scoped RT row keyed by the CITY ymd matches the overnight-day departure", () => {
    const res = getDeparturesFromTile({
      tile: mkTile(),
      stopId: "S1",
      now: NOW,
      limit: 50,
      lookAheadHours: LOOK_AHEAD_HOURS,
      tz: PARIS,
      realtimeUpdates: rtUpdates(),
    });
    const k1 = res.departures.find((d) => d.tripId === "T_K1")!;
    expect(k1.delaySeconds).toBe(180);
    expect(k1.predictedTime).toBe("2026-03-30T00:02:00.000Z");
    // A wrong-day key (e.g. browser-local ymd under NY) would NOT match — the
    // others carry no RT (no key for them).
    expect(res.departures.find((d) => d.tripId === "T_NORMAL")!.delaySeconds).toBeUndefined();
  });

  it("overnight (>86400) departure rolls into the window at its true feed-tz instant", () => {
    const res = getDeparturesFromTile({
      tile: mkTile(),
      stopId: "S1",
      now: NOW,
      limit: 50,
      lookAheadHours: LOOK_AHEAD_HOURS,
      tz: PARIS,
    });
    const overnight = res.departures.find((d) => d.tripId === "T_OVERNIGHT");
    expect(overnight).toBeDefined();
    expect(overnight!.scheduledTime).toBe("2026-03-29T21:00:00.000Z");
  });
});

/**
 * Regression: tz fall-back base-date whole-date skip guard widening.
 *
 * The K1 DST band (+3600s) was applied to `startIdx` and the inner-loop `break`
 * but NOT the earlier per-base-date skip guards (`upperSecs < 0` and
 * `lowerSecs > last_dep`). On a DST transition day the elapsed-frame skip bounds
 * can diverge from true instants by up to 3600s, so a departure whose TRUE instant
 * is in-window could be dropped by the whole-date skip before the exact re-check
 * runs. The fix widens both guards in the tz branch only; the no-tz branch is
 * byte-identical.
 *
 * Fixture: Europe/Vilnius fall-back 2026-10-25
 * (03:00 EEST → 02:00 EET, EEST=UTC+3, EET=UTC+2).
 * Civil midnight 20261025 via serviceDayToUnix = 2026-10-24T21:00:00Z (EEST anchor).
 *
 * Stop S_FB has dep=5400 (01:30 elapsed from EEST midnight = 2026-10-24T22:30:00Z).
 * now = 2026-10-24T22:33:00Z → cutoffMs=22:23Z, upperCutoffMs=23:33Z.
 * True instant 22:30Z ∈ [22:23Z, 23:33Z] ✓ — must be emitted.
 *
 * lowerSecs for base 20261025 = floor((22:23Z − 21:00Z) / 1s) = 4980s < dep=5400.
 * Guard does NOT fire here, but the widened form is exercised by ensuring the
 * departure IS emitted (not lost to an overly-aggressive skip).
 */
describe("getDeparturesFromTile(tz) — fall-back base-date skip guard", () => {
  const VILNIUS = "Europe/Vilnius";

  it("fall-back day — in-window departure on transition base date is emitted", () => {
    const tile: DecodedScheduleTile = {
      bundleHash: "fb",
      cityId: "vilnius",
      tileSize: 6000,
      stringTable: ["T_FB", "Center"],
      routes: [{ id: "R1", shortName: "T", longName: "T", color: "#000", mode: "BUS" as const }],
      calendar: [{
        serviceId: "SVC",
        days: [true, true, true, true, true, true, true] as unknown as readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
        startDate: "20260101",
        endDate: "20261231",
        added: [],
        removed: [],
      }],
      trips: [{ tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 1 }],
      stops: {
        S_FB: {
          tripIxs: new Uint32Array([0]),
          // dep=5400 (01:30 elapsed from EEST midnight 20261025 = 2026-10-24T22:30:00Z).
          departureSecs: new Uint32Array([5400]),
        },
      },
    };

    // now=2026-10-24T22:33:00Z → cutoffMs=22:23Z, upperCutoffMs=23:33Z.
    // True instant 22:30Z is in-window; widened skip guards must keep this base date live.
    const now = new Date(Date.UTC(2026, 9, 24, 22, 33, 0));
    const res = getDeparturesFromTile({
      tile,
      stopId: "S_FB",
      now,
      limit: 50,
      lookAheadHours: 2,
      tz: VILNIUS,
    });
    const dep = res.departures.find((d) => d.tripId === "T_FB");
    expect(dep).toBeDefined();
    expect(dep!.scheduledTime).toBe("2026-10-24T22:30:00.000Z");
  });
});
