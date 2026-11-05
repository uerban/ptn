import { describe, it, expect } from "vitest";
import { wireToItinerary } from "./raptor.js";

describe("raptor adapter mapping", () => {
  it("maps a WireItinerary to a shared Itinerary with CORRECT Oslo UTC instants", () => {
    // pt-serve emits LEG fields in snake_case (verified against live bytes); itinerary
    // fields are camelCase. Using the real wire shape here is what catches a field-name
    // mismatch (a camelCase fixture would pass against a snake_case-misreading adapter).
    const wire = {
      legs: [{ type: "transit" as const, from_stop_id: "A", to_stop_id: "B", depart_secs: 28800, arrive_secs: 30000, route_id: "RUT:Line:1", trip_id: "t1", mode: "BUS", board_stop_idx: 0, alight_stop_idx: 5, intermediate_stops: 4 }],
      boardSecs: 28800, alightSecs: 30000, transfers: 0,
    };
    // 28800s/30000s are secs-since-service-day-LOCAL-midnight (08:00 / 08:20 Oslo local).
    // Oslo is UTC+2 on 2026-06-16, so the correct UTC instants are 06:00Z / 06:20Z —
    // which is exactly what OTP would report for the same arrival.
    // (Default offset 7200 = Europe/Oslo summer; passed explicitly here for clarity.)
    const it = wireToItinerary(wire, 20260616, 7200);
    expect(it.transfers).toBe(0);
    expect(it.durationSeconds).toBe(1200);
    expect(it.legs[0]!.mode).toBe("BUS"); // : route_type 401 metro collapses to BUS — compare timing, not mode
    expect(it.arrivalTime).toBe("2026-06-16T06:20:00.000Z");   // 08:20 Oslo local = 06:20 UTC
    expect(it.departureTime).toBe("2026-06-16T06:00:00.000Z"); // 08:00 Oslo local = 06:00 UTC
    // Leg-level conversion must read the snake_case leg fields (the integration-bug guard):
    expect(it.legs[0]!.arrivalTime).toBe("2026-06-16T06:20:00.000Z");
    expect(it.legs[0]!.departureTime).toBe("2026-06-16T06:00:00.000Z");
  });

  it("with tzOffset 0 (UTC feed) treats secs as UTC-since-midnight", () => {
    const wire = { legs: [], boardSecs: 28800, alightSecs: 30000, transfers: 0 };
    const it = wireToItinerary(wire, 20260616, 0);
    expect(it.arrivalTime).toBe("2026-06-16T08:20:00.000Z"); // no offset → local==UTC
  });
});
