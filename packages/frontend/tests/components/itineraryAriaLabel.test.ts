import { describe, it, expect } from "vitest";
import type { Itinerary } from "@pt/shared";
import { itineraryAriaLabel } from "../../src/components/RouteResults/shared/itineraryAriaLabel.ts";
import { deriveItineraryDisplay } from "../../src/components/RouteResults/shared/itineraryDisplay.ts";
import { ms, place, ride, walk, itinerary as buildItinerary } from "./shared-fixtures.ts";

/** English-fallback translator — mirrors the default I18nContext value. */
const t = (_key: string, fallback?: string) => fallback ?? _key;

const NOW = ms("2026-03-03T09:50:00Z");

function label(
  it: Itinerary,
  opts: {
    bufferSeconds?: number;
    fastest?: boolean;
    referenceNowMs?: number;
    runSpeedRatio?: number;
    nextDepartureInMin?: number;
    firstRideCancelled?: boolean;
    firstRideRemoved?: boolean;
  } = {},
) {
  const referenceNowMs = opts.referenceNowMs ?? NOW;
  const bufferSeconds = opts.bufferSeconds ?? 300;
  const display = deriveItineraryDisplay(it, {
    referenceNowMs,
    bufferSeconds,
    ...(opts.runSpeedRatio !== undefined ? { runSpeedRatio: opts.runSpeedRatio } : {}),
    firstRideCancelled: opts.firstRideCancelled,
    firstRideRemoved: opts.firstRideRemoved,
  });
  return itineraryAriaLabel(it, display, {
    t,
    locale: "en",
    formattingLocale: "en-GB",
    referenceNowMs,
    feedTz: "UTC",
    fastest: opts.fastest ?? false,
    nextDepartureInMin: opts.nextDepartureInMin,
  });
}

/** A two-ride trip with a comfortable 5 min transfer at Stop B. */
function transferTrip(overrides: Partial<Itinerary> = {}): Itinerary {
  const base = buildItinerary(
    [
      ride({
        from: place("Stop A", 0, 0, "a"),
        to: place("Stop B", 1, 1, "b"),
        depart: "2026-03-03T10:00:00Z",
        arrive: "2026-03-03T10:15:00Z",
        routeShortName: "42",
      }),
      ride({
        mode: "TRAM",
        from: place("Stop B", 1, 1, "b"),
        to: place("Stop C", 2, 2, "c"),
        depart: "2026-03-03T10:20:00Z",
        arrive: "2026-03-03T10:35:00Z",
        routeShortName: "5",
      }),
    ],
    1,
  );
  return { ...base, walkingDistanceMeters: 320, ...overrides };
}

describe("itineraryAriaLabel — clause order", () => {
  it("orders the label by how soon the rider needs each fact", () => {
    const out = label(transferTrip(), { fastest: true });

    // The whole point of the author-supplied name: the rider can act on the
    // first two clauses without hearing the rest.
    expect(out.startsWith("Fastest. Leave in 5 min. ")).toBe(true);
    expect(out).toBe(
      "Fastest. Leave in 5 min. Board here. " +
        "Bus 42 to Stop B, then Tram 5 to Stop C. " +
        "35 min, arrives 10:35. 1 transfer, 320 m walking.",
    );
  });

  it("puts the leg chain ahead of duration, and cost last", () => {
    const out = label(transferTrip());
    const legs = out.indexOf("Bus 42 to Stop B");
    const duration = out.indexOf("35 min, arrives");
    const cost = out.indexOf("1 transfer");
    expect(legs).toBeGreaterThan(-1);
    expect(legs).toBeLessThan(duration);
    expect(duration).toBeLessThan(cost);
  });

  it("emits exactly one terminating period and no empty clauses", () => {
    const out = label(transferTrip(), { fastest: true });
    expect(out.endsWith(".")).toBe(true);
    expect(out).not.toMatch(/\.\./);
    expect(out).not.toMatch(/\.\s+\./);
    expect(out).not.toMatch(/ {2}/);
  });

  it("names the mode alone when a leg carries no route short name", () => {
    const it = buildItinerary([
      ride({
        mode: "METRO",
        from: place("Stop A"),
        to: place("Stop B"),
        depart: "2026-03-03T10:00:00Z",
        arrive: "2026-03-03T10:15:00Z",
      }),
    ]);
    expect(label(it)).toContain("Metro to Stop B");
    expect(label(it)).not.toMatch(/ {2}/);
  });

  it("describes a walk-only itinerary as a walk, not an empty leg chain", () => {
    const it = {
      ...buildItinerary([
        walk({
          from: place("Home"),
          to: place("Office"),
          depart: "2026-03-03T10:00:00Z",
          arrive: "2026-03-03T10:12:00Z",
          meters: 900,
        }),
      ]),
      walkingDistanceMeters: 900,
    };
    const out = label(it);
    expect(out).toContain("walk 12 min");
    expect(out).toContain("900 m walking");
  });

  it("omits the walking clause when the trip has no walking", () => {
    const out = label(transferTrip({ walkingDistanceMeters: 0 }));
    expect(out).toContain("1 transfer.");
    expect(out).not.toContain("walking");
  });
});

describe("itineraryAriaLabel — boarding stop", () => {
  /** Same departure minute, different boarding stop — the case that motivated
   *  the clause: by ear these two cards were previously indistinguishable. */
  function fromPin(boardStop: string, accessMeters: number, line: string): Itinerary {
    const base = buildItinerary([
      walk({
        from: place("Dropped pin"),
        to: place(boardStop, 1, 1, "b"),
        depart: "2026-03-03T09:58:00Z",
        arrive: "2026-03-03T10:00:00Z",
        meters: accessMeters,
      }),
      ride({
        from: place(boardStop, 1, 1, "b"),
        to: place("Justiniškės", 2, 2, "j"),
        depart: "2026-03-03T10:00:00Z",
        arrive: "2026-03-03T10:11:00Z",
        routeShortName: line,
      }),
    ]);
    return { ...base, walkingDistanceMeters: accessMeters };
  }

  it("names the boarding stop and its distance when the trip starts elsewhere", () => {
    const out = label(fromPin("Konstitucijos pr.", 103, "43"), { bufferSeconds: 0 });
    expect(out).toContain("Board at Konstitucijos pr., 103 m");
    // Boarding comes before the ride — walk there first, then know what to catch.
    expect(out.indexOf("Board at")).toBeLessThan(out.indexOf("Bus 43"));
  });

  it("distinguishes two same-minute options by boarding stop and distance", () => {
    const a = label(fromPin("Konstitucijos pr.", 103, "43"), { bufferSeconds: 0 });
    const b = label(fromPin("Perkūnkiemis", 393, "40"), { bufferSeconds: 0 });
    expect(a).toContain("Board at Konstitucijos pr., 103 m");
    expect(b).toContain("Board at Perkūnkiemis, 393 m");
    expect(a).not.toBe(b);
  });

  it("keeps the distance when two stops share a name across the road", () => {
    const near = label(fromPin("Žalgirio st.", 40, "5"), { bufferSeconds: 0 });
    const far = label(fromPin("Žalgirio st.", 210, "5"), { bufferSeconds: 0 });
    expect(near).toContain("Board at Žalgirio st., 40 m");
    expect(far).toContain("Board at Žalgirio st., 210 m");
    expect(near).not.toBe(far);
  });

  it("drops the walking total when the access walk already stated it", () => {
    const out = label(fromPin("Konstitucijos pr.", 103, "43"), { bufferSeconds: 0 });
    expect(out).toContain("103 m");
    expect(out).not.toContain("103 m walking");
    expect(out).toContain("0 transfers.");
  });

  it("keeps the walking total when there is walking beyond the access leg", () => {
    const it = fromPin("Konstitucijos pr.", 103, "43");
    it.walkingDistanceMeters = 450; // access walk + a walk at the far end
    const out = label(it, { bufferSeconds: 0 });
    expect(out).toContain("Board at Konstitucijos pr., 103 m");
    expect(out).toContain("450 m walking");
  });

  it("says board here when the trip already starts at the boarding stop", () => {
    const out = label(transferTrip({ walkingDistanceMeters: 0 }), { bufferSeconds: 0 });
    expect(out).toContain("Board here");
    expect(out).not.toContain("Board at");
    expect(out.indexOf("Board here")).toBeLessThan(out.indexOf("Bus 42"));
  });

  it("names the stop without a distance when the feed gave none", () => {
    // toSegments coerces a leg with no distanceMeters to 0. Announcing "0 m"
    // would state a measurement the feed never made — live Vilnius data hit
    // this on the very first run.
    const base = buildItinerary([
      walk({
        from: place("Šeškinės poliklinika", 0, 0, "a"),
        to: place("Buivydiškių st.", 1, 1, "b"),
        depart: "2026-03-03T09:58:00Z",
        arrive: "2026-03-03T10:00:00Z",
      }),
      ride({
        from: place("Buivydiškių st.", 1, 1, "b"),
        to: place("Nacionalinė dailės galerija", 2, 2, "n"),
        depart: "2026-03-03T10:00:00Z",
        arrive: "2026-03-03T10:30:00Z",
        routeShortName: "43",
      }),
    ]);
    const out = label({ ...base, walkingDistanceMeters: 974 }, { bufferSeconds: 0 });
    expect(out).toContain("Board at Buivydiškių st.");
    // Anchored to the boarding clause — a bare "0 m" also matches "1[0 m]in".
    expect(out).not.toMatch(/Board at [^.]*,\s*0\s*m/);
    // An unknown access distance covers nothing, so the total still gets said.
    expect(out).toContain("974 m walking");
  });

  it("says board here when the access walk starts and ends at one stop", () => {
    const base = buildItinerary([
      walk({
        from: place("Stop A", 0, 0, "a"),
        to: place("Stop A", 0, 0, "a"),
        depart: "2026-03-03T09:59:00Z",
        arrive: "2026-03-03T10:00:00Z",
        meters: 30,
      }),
      ride({
        from: place("Stop A", 0, 0, "a"),
        to: place("Stop B", 1, 1, "b"),
        depart: "2026-03-03T10:00:00Z",
        arrive: "2026-03-03T10:15:00Z",
        routeShortName: "9",
      }),
    ]);
    const out = label(base, { bufferSeconds: 0 });
    expect(out).toContain("Board here");
    expect(out).not.toContain("Board at");
  });

  it("does not announce boarding for a walk-only itinerary", () => {
    const it = {
      ...buildItinerary([
        walk({ from: place("Home"), to: place("Office"), depart: "2026-03-03T10:00:00Z", arrive: "2026-03-03T10:12:00Z", meters: 900 }),
      ]),
      walkingDistanceMeters: 900,
    };
    const out = label(it);
    expect(out).not.toContain("Board");
  });
});

describe("itineraryAriaLabel — urgency leads", () => {
  /** Tight 1 min transfer that the inbound bus's live delay eats entirely. */
  function missTrip(overrides: Partial<Itinerary> = {}): Itinerary {
    const base = buildItinerary(
      [
        ride({
          from: place("Stop A", 0, 0, "a"),
          to: place("Stop B", 1, 1, "b"),
          depart: "2026-03-03T10:00:00Z",
          arrive: "2026-03-03T10:15:00Z",
          routeShortName: "42",
          delaySeconds: 360,
        }),
        ride({
          mode: "TRAM",
          from: place("Stop B", 1, 1, "b"),
          to: place("Stop C", 2, 2, "c"),
          depart: "2026-03-03T10:16:00Z",
          arrive: "2026-03-03T10:35:00Z",
          routeShortName: "5",
        }),
      ],
      1,
    );
    return { ...base, walkingDistanceMeters: 320, ...overrides };
  }

  it("leads with the miss-risk warning, ahead of the fastest cue", () => {
    const out = label(missTrip(), { fastest: true });
    expect(
      out.startsWith("Live delay may cause you to miss a transfer. Fastest."),
    ).toBe(true);
  });

  it("leads with a plain live delay when no transfer is at risk", () => {
    const it = transferTrip();
    it.legs[0].delaySeconds = 360;
    const out = label(it);
    expect(out.startsWith("Live: 42 is running +6 min. ")).toBe(true);
  });

  it("lets a cancellation outrank the miss risk", () => {
    const out = label(missTrip({ cancelled: true }));
    expect(out.startsWith("Trip is cancelled. ")).toBe(true);
    expect(out).not.toContain("miss a transfer");
  });

  it("reports unreliable timing when nothing stronger fired", () => {
    const out = label(transferTrip({ timingUnreliable: true }));
    expect(out.startsWith("Trip has unreliable timing. ")).toBe(true);
  });
});

describe("itineraryAriaLabel — leave cue", () => {
  it("counts down to the buffered leave time", () => {
    // Departure 10:00, 5 min buffer, now 09:50 → leave in 5 min.
    expect(label(transferTrip(), { bufferSeconds: 300 })).toContain(
      "Leave in 5 min",
    );
  });

  it("counts down to the real departure when the buffer is turned off", () => {
    // Regression guard: `leadingWaitSeconds` is pinned at 0 whenever the
    // caller passes bufferSeconds <= 0, so deriving the cue from it would
    // announce "Leave now" for a bus that is still 10 minutes out.
    const out = label(transferTrip(), { bufferSeconds: 0 });
    expect(out).toContain("Leave in 10 min");
    expect(out).not.toContain("Leave now");
  });

  it("keeps the countdown up to an hour out", () => {
    const out = label(transferTrip(), {
      bufferSeconds: 0,
      referenceNowMs: ms("2026-03-03T09:00:00Z"),
    });
    expect(out).toContain("Leave in 60 min");
  });

  it("switches to a clock time once the countdown passes an hour", () => {
    // A search for later in the day, or a few taps on "Later", puts the first
    // departure hours out — "Leave in 412 min" is arithmetic, not guidance.
    const out = label(transferTrip(), {
      bufferSeconds: 300,
      referenceNowMs: ms("2026-03-03T03:00:00Z"),
    });
    expect(out).toContain("Leave at 09:55");
    expect(out).not.toMatch(/Leave in \d/);
  });

  it("says leave now once the buffered leave time has arrived", () => {
    const out = label(transferTrip(), {
      bufferSeconds: 300,
      referenceNowMs: ms("2026-03-03T09:56:00Z"),
    });
    expect(out).toContain("Leave now");
  });

  it("drops the leave cue entirely once the trip has departed", () => {
    const out = label(transferTrip(), {
      referenceNowMs: ms("2026-03-03T10:05:00Z"),
    });
    expect(out).not.toContain("Leave");
    // The boarding clause survives — it is not part of the leave cue.
    expect(out.startsWith("Board here. Bus 42 to Stop B")).toBe(true);
  });
});

describe("itineraryAriaLabel — catch cue", () => {
  // A 4-min walk to a bus at 10:00.
  const walkTrip = (): Itinerary =>
    buildItinerary([
      walk({ from: place("Home"), to: place("Stop A", 0, 0, "a"), depart: "2026-03-03T09:50:00Z", arrive: "2026-03-03T09:54:00Z" }),
      ride({ from: place("Stop A", 0, 0, "a"), to: place("Stop C", 2, 2, "c"), depart: "2026-03-03T10:00:00Z", arrive: "2026-03-03T10:20:00Z", routeShortName: "42" }),
    ]);

  it("says there is no time to spare when walking only just makes it", () => {
    const out = label(walkTrip(), { referenceNowMs: ms("2026-03-03T09:55:30Z") });
    expect(out).toContain("Leave now, no time to spare");
  });

  it("says to hurry when only a run makes it", () => {
    const out = label(walkTrip(), { referenceNowMs: ms("2026-03-03T09:57:00Z"), runSpeedRatio: 2 });
    expect(out).toContain("Leave now and hurry to make it");
    expect(out).not.toContain("Leave now, no time to spare");
  });

  it("leads with the cancellation and offers the next departure", () => {
    const out = label(walkTrip(), { firstRideCancelled: true, nextDepartureInMin: 10 });
    expect(out.startsWith("Trip is cancelled. ")).toBe(true);
    expect(out).toContain("Next departure in about 10 min");
    expect(out).not.toMatch(/Leave (now|in|at)/);
  });

  it("says a removed departure is no longer scheduled, never cancelled", () => {
    const out = label(walkTrip(), { firstRideRemoved: true, nextDepartureInMin: 10 });
    expect(out.startsWith("No longer scheduled. ")).toBe(true);
    expect(out).toContain("Next departure in about 10 min");
    expect(out).not.toMatch(/cancel/i);
    expect(out).not.toMatch(/Leave (now|in|at)/);
  });

  it("offers the next departure alongside a likely miss", () => {
    const out = label(walkTrip(), { referenceNowMs: ms("2026-03-03T09:59:00Z"), nextDepartureInMin: 15 });
    expect(out).toContain("Likely to miss this departure, next in about 15 min");
  });

  it("says the departure will likely be missed when nothing makes it", () => {
    const out = label(walkTrip(), { referenceNowMs: ms("2026-03-03T09:59:00Z"), runSpeedRatio: 2 });
    expect(out).toContain("Likely to miss this departure");
    expect(out).not.toMatch(/Leave (now|in)/);
  });
});

describe("itineraryAriaLabel — trip length", () => {
  it("counts from the leave time, like the card header", () => {
    // 09:50, 4-min walk to a 10:00 bus arriving 10:20, 5-min buffer: leave 09:51.
    const trip = buildItinerary([
      walk({ from: place("Home"), to: place("Stop A", 0, 0, "a"), depart: "2026-03-03T09:50:00Z", arrive: "2026-03-03T09:54:00Z" }),
      ride({ from: place("Stop A", 0, 0, "a"), to: place("Stop C", 2, 2, "c"), depart: "2026-03-03T10:00:00Z", arrive: "2026-03-03T10:20:00Z", routeShortName: "42" }),
    ]);
    expect(label(trip)).toContain("29 min, arrives");
  });
});
