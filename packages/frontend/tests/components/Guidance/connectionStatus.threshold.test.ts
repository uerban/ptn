import { describe, it, expect } from "vitest";
import { computeConnectionStatus } from "../../../src/components/Guidance/connectionStatus.ts";
import type { Leg } from "@pt/shared";

// Regression guard for D-022 ("connection-status extra-time threshold inverted").
// The threshold direction in connectionStatus.ts is correct: a positive
// `delaySeconds` on the next trip means the next vehicle is running late,
// which gives the user extra time at the transfer. These cases lock that in
// so a future flip of the comparison fails the test instead of silently
// shipping a copy regression.

const baseCurrent: Leg = {
  mode: "TRAM",
  from: { name: "Stop A", location: { lat: 0, lon: 0 } },
  to: { name: "Stop B", location: { lat: 0, lon: 0 } },
  // arrivalTime is the anchor; we move next.departureTime to dial in buffer.
  departureTime: "2026-04-25T09:50:00Z",
  arrivalTime: "2026-04-25T10:00:00Z",
  durationSeconds: 600,
  tripId: "trip_current",
  routeShortName: "2",
};

function makeNext(departureTime: string): Leg {
  return {
    mode: "BUS",
    from: { name: "Stop B", location: { lat: 0, lon: 0 } },
    to: { name: "Stop C", location: { lat: 0, lon: 0 } },
    departureTime,
    arrivalTime: "2026-04-25T10:30:00Z",
    durationSeconds: 600,
    tripId: "trip_next",
    routeShortName: "5",
  };
}

const rt = (delays: Record<string, number>) => ({
  getTripDelay: (tripId: string) => {
    const d = delays[tripId];
    return d !== undefined ? { delaySeconds: d, cancelled: false } : null;
  },
});

describe("computeConnectionStatus — threshold direction (D-022)", () => {
  it("nextDelay=60s, scheduled buffer=240s → buffer=300s → extraTime", () => {
    // schedule buffer = 4 min, next leg 1 min late → effective buffer 5 min,
    // and nextDelay > 30 → extraTime branch
    const next = makeNext("2026-04-25T10:04:00Z");
    const result = computeConnectionStatus(baseCurrent, next, rt({ trip_next: 60 }));
    expect(result?.safety).toBe("extraTime");
    expect(result?.message).toContain("extra time");
  });

  it("nextDelay=0, buffer=60s → atRisk (tight, < 120s)", () => {
    const next = makeNext("2026-04-25T10:01:00Z");
    const result = computeConnectionStatus(baseCurrent, next, rt({}));
    expect(result?.safety).toBe("atRisk");
    expect(result?.message).toMatch(/[Tt]ight/);
  });

  it("nextDelay=0, buffer=600s → safe", () => {
    const next = makeNext("2026-04-25T10:10:00Z");
    const result = computeConnectionStatus(baseCurrent, next, rt({}));
    expect(result?.safety).toBe("safe");
  });
});

describe("computeConnectionStatus — a cancelled connection", () => {
  const cancelledNext = {
    getTripDelay: (tripId: string) =>
      tripId === "trip_next" ? { delaySeconds: 300, cancelled: true } : null,
  };

  it("is at risk, and says why — not 'extra time' from its delay", () => {
    const out = computeConnectionStatus(baseCurrent, makeNext("2026-04-25T10:04:00Z"), cancelledNext);
    expect(out).toEqual({ safety: "atRisk", message: "Connection cancelled — 5 is not running" });
  });
});

describe("computeConnectionStatus — a removed connection", () => {
  it("is at risk, worded as no longer scheduled rather than cancelled", () => {
    const removedNext = {
      getTripDelay: (tripId: string) =>
        tripId === "trip_next" ? { delaySeconds: 0, cancelled: false, deleted: true } : null,
    };
    const out = computeConnectionStatus(baseCurrent, makeNext("2026-04-25T10:04:00Z"), removedNext);
    expect(out).toEqual({ safety: "atRisk", message: "Connection no longer scheduled — 5" });
  });
});
