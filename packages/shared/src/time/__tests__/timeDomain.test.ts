/**
 * TypeScript leg of the service-day→unix DST differential gate.
 *
 * Reads the SAME committed fixture as the Rust leg
 * (`crates/pt-serve/tests/time_domain.rs`), where chrono-tz produced
 * `expectedUnix`, and asserts the JS mirror `serviceDayToUnix` reproduces it
 * byte-for-byte for every case. If a case mismatches, fix `timeDomain.ts` —
 * NEVER the fixture. The CI gate (`.github/workflows/tz-differential.yml`)
 * requires this summary line, the Rust one, zero mismatch, and an exact count.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { serviceDayToUnix, unixToServiceDay } from "../timeDomain.js";

interface TzCase {
  label: string;
  tz: string;
  ymd: number;
  secs: number;
  dstKind: "single" | "none" | "ambiguous";
  expectedUnix: number;
}

interface TzInverseCase {
  label: string;
  tz: string;
  unixSec: number;
  expectedServiceDateYmd: number;
  expectedSecsOfServiceDay: number;
}

// Fixture lives at packages/shared/tests/__fixtures__/tz-cases.json; this test
// is at packages/shared/src/time/__tests__/, so climb three dirs.
const fixtureUrl = new URL("../../../tests/__fixtures__/tz-cases.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as {
  forward: TzCase[];
  inverse: TzInverseCase[];
};
const cases: TzCase[] = fixture.forward;
const inverseCases: TzInverseCase[] = fixture.inverse;

/**
 * Re-derive the DST kind of a local wall-clock time in zone `tz` using the
 * same Intl offset-sampling logic as `serviceDayToUnix`.
 *
 * Mirrors the bracket logic in `timeDomain.ts`:
 *   - offBefore === offAfter → "single" (no transition in bracket)
 *   - both candidates round-trip → "ambiguous" (fall-back overlap)
 *   - neither candidate round-trips → "none" (spring-forward gap)
 *   - exactly one round-trips → "single" (unambiguous post-transition)
 *
 * Only used for non-overnight cases (`secs < 86400`); overnight times that
 * land after a transition are "single" by definition (unambiguous wall clock)
 * but the ±24h bracket logic may span the transition, so we skip them to
 * avoid the test asserting a derived value that doesn't match the fixture's
 * chrono-tz classification.
 */
function deriveDstKind(
  ymd: number,
  secs: number,
  tz: string,
): "single" | "none" | "ambiguous" {
  const y = Math.floor(ymd / 10000);
  const m = Math.floor((ymd % 10000) / 100);
  const d = ymd % 100;
  const naiveAsUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) + secs * 1000;
  const naiveSec = Math.floor(naiveAsUtcMs / 1000);

  function offsetMinutesAtUtc(utcMs: number): number {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    return Math.round((asUtc - utcMs) / 60000);
  }

  const offBefore = offsetMinutesAtUtc(naiveAsUtcMs - 24 * 3600 * 1000);
  const offAfter = offsetMinutesAtUtc(naiveAsUtcMs + 24 * 3600 * 1000);

  if (offBefore === offAfter) return "single";

  const withOffset = (offMin: number) => naiveSec - offMin * 60;
  const candValid = (offMin: number) =>
    offsetMinutesAtUtc(withOffset(offMin) * 1000) === offMin;

  const beforeValid = candValid(offBefore);
  const afterValid = candValid(offAfter);

  if (beforeValid && afterValid) return "ambiguous";
  if (!beforeValid && !afterValid) return "none";
  return "single";
}

describe("serviceDayToUnix DST differential (vs chrono-tz oracle fixture)", () => {
  it("has a non-empty fixture", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`${c.label} (${c.dstKind})`, () => {
      expect(serviceDayToUnix(c.ymd, c.secs, c.tz)).toBe(c.expectedUnix);
    });
  }

  // Parity with the Rust leg: re-derive the local-result kind via the same
  // Intl offset-sampling bracket logic and assert it equals the fixture's
  // chrono-tz-derived `dstKind`. Overnight cases (secs >= 86400) are skipped:
  // the wall clock time they land on is unambiguous, but the ±24h bracket may
  // straddle the transition and the comparison to the chrono fixture label
  // would be fragile.
  for (const c of cases) {
    if (c.secs >= 86400) continue;
    it(`${c.label} — dstKind parity (fixture=${c.dstKind})`, () => {
      const derived = deriveDstKind(c.ymd, c.secs, c.tz);
      expect(derived).toBe(c.dstKind);
    });
  }

  it("matches the oracle on every case and prints the summary line", () => {
    let mismatch = 0;
    for (const c of cases) {
      if (serviceDayToUnix(c.ymd, c.secs, c.tz) !== c.expectedUnix) mismatch += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`tz-differential-ts: ${cases.length} cases compared, ${mismatch} mismatch`);
    expect(mismatch).toBe(0);
  });
});

describe("unixToServiceDay inverse differential (vs chrono-tz oracle fixture)", () => {
  it("has a non-empty inverse fixture", () => {
    expect(inverseCases.length).toBeGreaterThan(0);
  });

  for (const c of inverseCases) {
    it(`${c.label}`, () => {
      expect(unixToServiceDay(c.unixSec, c.tz)).toEqual({
        serviceDateYmd: c.expectedServiceDateYmd,
        secsOfServiceDay: c.expectedSecsOfServiceDay,
      });
    });
  }

  it("matches the oracle on every inverse case and prints the summary line", () => {
    let mismatch = 0;
    for (const c of inverseCases) {
      const r = unixToServiceDay(c.unixSec, c.tz);
      if (r.serviceDateYmd !== c.expectedServiceDateYmd || r.secsOfServiceDay !== c.expectedSecsOfServiceDay) {
        mismatch += 1;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`tz-differential-ts-inverse: ${inverseCases.length} cases compared, ${mismatch} mismatch`);
    expect(mismatch).toBe(0);
  });
});
