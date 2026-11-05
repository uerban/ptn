/**
 * Cross-tz + local-user correctness. `test:tz` runs this twice:
 * TZ=America/New_York (cross-tz) and TZ=Europe/Vilnius (local-user no-change gate).
 * The bug under guard is device-local time getters, so this suite ONLY means
 * anything under a non-UTC process TZ — the harness `it` below asserts that, and
 * the device-dependent assertions branch on `isLocal`.
 *
 * NOTE: this is `crossTz.spec.ts` (NOT `.test.ts`) and lives under `src/__tz_tests__/`
 * so the base `vitest.config.ts` `exclude` keeps it OUT of the default UTC `pnpm test`;
 * only `vitest.tz.config.ts` (which clears the exclude + sets `include`) collects it.
 */
import { describe, expect, it } from "vitest";
import { serviceDayToUnix, unixToServiceDay } from "@pt/shared/time";
import { resolveActiveServices } from "../services/serviceDay.ts";
import { formatTime } from "../components/RouteResults/shared/format.ts";
import type { RaptorIndexService } from "../services/raptorIndex.ts";

const VILNIUS = "Europe/Vilnius";
const DEVICE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const isLocal = DEVICE === VILNIUS; // local-user run vs cross-tz run

function friOnly() {
  return new Map<string, RaptorIndexService>([
    [
      "fri",
      {
        startDate: "20260101",
        endDate: "20261231",
        days: [false, false, false, false, true, false, false],
        exceptions: {},
      } as RaptorIndexService,
    ],
  ]);
}

it("harness runs under a non-UTC zone [R-fold #19]", () => {
  expect(DEVICE).not.toBe("UTC");
  expect(new Date().getTimezoneOffset()).not.toBe(0);
});

// Device-INDEPENDENT (explicit instant + tz): correct in BOTH runs.
describe("query + display (feed-tz)", () => {
  it("00:30 Vilnius resolves the city's service day + seconds", () => {
    const instant = Date.UTC(2026, 0, 15, 22, 30, 0) / 1000;
    expect(unixToServiceDay(instant, VILNIUS)).toEqual({
      serviceDateYmd: 20260116,
      secsOfServiceDay: 1800,
    });
  });
  it("resolves the feed-tz weekday near local midnight", () => {
    const instant = new Date(Date.UTC(2026, 0, 15, 22, 30, 0)); // Fri 00:30 in Vilnius
    expect(resolveActiveServices(friOnly(), instant, VILNIUS).has("fri")).toBe(true);
  });
  it("renders the feed-tz wall clock", () => {
    const iso = new Date(serviceDayToUnix(20260116, 1800, VILNIUS) * 1000).toISOString();
    expect(formatTime(iso, "en-GB", VILNIUS)).toBe("00:30");
  });
  it("overnight result displays the true instant via the QUERY service date", () => {
    // Overnight trip filed under queryDay 2026-03-29 (spring-forward day) with the
    // engine's -86400-rewritten secs 01:30 (original 25:30 on prev day). Projecting
    // against the QUERY day gives the true instant — independently: 01:30 Vilnius
    // pre-gap (+02:00) = 2026-03-28 23:30 UTC. (No provenance needed.)
    expect(serviceDayToUnix(20260329, 1 * 3600 + 30 * 60, VILNIUS)).toBe(
      Date.UTC(2026, 2, 28, 23, 30, 0) / 1000,
    );
  });
  it("fall-back overlap renders the earlier occurrence's wall clock without error [R-fold v3 SHOULD-FIX]", () => {
    // 2026-10-25 03:30 Vilnius is ambiguous (overlap); the frozen policy takes the
    // earlier instant. Display projects + formats it as 03:30 in feed tz.
    const iso = new Date(serviceDayToUnix(20261025, 3 * 3600 + 30 * 60, VILNIUS) * 1000).toISOString();
    expect(formatTime(iso, "en-GB", VILNIUS)).toBe("03:30");
  });
});

// Cross-tz fail-red — meaningful ONLY when device tz != feed tz.
describe.skipIf(isLocal)("cross-tz fail-red (device != feed)", () => {
  it("device-local resolution sees the WRONG weekday (no feedTz)", () => {
    const instant = new Date(Date.UTC(2026, 0, 15, 22, 30, 0));
    expect(resolveActiveServices(friOnly(), instant).has("fri")).toBe(false); // NY: Thursday
  });
  it("device formatting differs from feed formatting", () => {
    const iso = new Date(serviceDayToUnix(20260116, 1800, VILNIUS) * 1000).toISOString();
    expect(formatTime(iso, "en-GB")).not.toBe("00:30");
  });
});

// Local-user no-change gate [R-fold #16] — ONLY under TZ == feed tz. The new
// feed-tz path must be byte-identical to the legacy device-local derivation
// across a DST-transition day + near-midnight (unambiguous instants).
describe.runIf(isLocal)("local-user byte-identical (device == feed)", () => {
  for (const ms of [
    Date.UTC(2026, 0, 15, 22, 30, 0), // 00:30 Vilnius — near-midnight winter
    Date.UTC(2026, 2, 29, 0, 30, 0), // 02:30 Vilnius — just BEFORE the spring gap (+02:00)
    Date.UTC(2026, 2, 29, 1, 30, 0), // 04:30 Vilnius — just AFTER the spring gap (+03:00) [R-fold v3 SHOULD-FIX]
    Date.UTC(2026, 9, 25, 0, 30, 0), // 03:30 Vilnius (EEST, earlier occurrence) — inside the fall-back overlap [R-fold v3 SHOULD-FIX]
  ]) {
    it(`feed-tz secs == device getHours() cascade @ ${ms}`, () => {
      const d = new Date(ms);
      const legacy = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
      expect(unixToServiceDay(Math.floor(ms / 1000), VILNIUS).secsOfServiceDay).toBe(legacy);
    });
    it(`feed-tz label == device label @ ${ms}`, () => {
      const iso = new Date(ms).toISOString();
      expect(formatTime(iso, "en-GB", VILNIUS)).toBe(formatTime(iso, "en-GB"));
    });
  }
});

// Pagination [R-fold #23] — handleEarlier reads the (now true-instant) ISO and
// subtracts 30 device-local minutes. Accepted as instant-ish; assert the next
// query is strictly earlier and its feed-tz decomposition is sane (no crash on a
// transition day). Uses a non-gap instant to keep the assertion robust.
describe("pagination", () => {
  it("handleEarlier yields a strictly earlier instant that decomposes in feed tz", () => {
    const dep = serviceDayToUnix(20260115, 12 * 3600, VILNIUS); // noon, no DST edge
    const earlier = new Date(dep * 1000);
    earlier.setMinutes(earlier.getMinutes() - 30);
    expect(earlier.getTime()).toBeLessThan(dep * 1000);
    const { secsOfServiceDay } = unixToServiceDay(Math.floor(earlier.getTime() / 1000), VILNIUS);
    expect(secsOfServiceDay).toBe(11 * 3600 + 30 * 60); // 11:30 Vilnius
  });
});
