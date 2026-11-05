import { describe, it, expect } from "vitest";
import { buildRoutingView } from "./RoutingView.js";
import { DEP_SECS_NOT_SERVED } from "@pt/shared";
import { emptyTestIdentity, testIdentityWith } from "../identity/testIdentity.js";

describe("RoutingView (CSR + ix storage)", () => {
  it("routeCount reflects the number of routes built", () => {
    const identity = testIdentityWith({
      trips: ["t1", "t2"],
      services: ["svc"],
      headsigns: ["Downtown"],
    });
    const view = buildRoutingView({
      routes: [
        {
          routeId: "R1",
          stopIds: ["A", "B"],
          trips: [
            { tripId: "t1", serviceId: "svc", headsign: "Downtown", departureSecs: [0, 60] },
            { tripId: "t2", serviceId: "svc", headsign: "Downtown", departureSecs: [120, 180] },
          ],
        },
      ],
    }, identity);

    expect(view.routeCount).toBe(1);
  });

  it("getRouteSchedule returns a RouteSchedule with correctly sized typed arrays", () => {
    const identity = testIdentityWith({
      trips: ["t1", "t2", "t3"],
      services: ["svc"],
      headsigns: ["H"],
    });
    const view = buildRoutingView({
      routes: [
        {
          routeId: "R1",
          stopIds: ["A", "B", "C"],
          trips: [
            { tripId: "t1", serviceId: "svc", headsign: "H", departureSecs: [0, 60, 120] },
            { tripId: "t2", serviceId: "svc", headsign: "H", departureSecs: [10, 70, 130] },
            { tripId: "t3", serviceId: "svc", headsign: "H", departureSecs: [20, 80, 140] },
          ],
        },
      ],
    }, identity);

    const sched = view.getRouteSchedule("R1");
    expect(sched).toBeDefined();
    expect(sched!.stopCount).toBe(3);
    expect(sched!.tripCount).toBe(3);
    expect(sched!.tripIx).toBeInstanceOf(Uint32Array);
    expect(sched!.tripIx.length).toBe(3);
    expect(sched!.serviceIx.length).toBe(3);
    expect(sched!.headsignIx.length).toBe(3);
    expect(sched!.departureSecs).toBeInstanceOf(Uint32Array);
    expect(sched!.departureSecs.length).toBe(9); // 3 trips * 3 stops
  });

  it("CSR layout is trip-major: departureSecs[t * stopCount + s]", () => {
    const identity = testIdentityWith({
      trips: ["t1", "t2"],
      services: ["svc"],
      headsigns: ["H"],
    });
    const view = buildRoutingView({
      routes: [
        {
          routeId: "R1",
          stopIds: ["A", "B"],
          trips: [
            { tripId: "t1", serviceId: "svc", headsign: "H", departureSecs: [100, 200] },
            { tripId: "t2", serviceId: "svc", headsign: "H", departureSecs: [300, 400] },
          ],
        },
      ],
    }, identity);

    const sched = view.getRouteSchedule("R1")!;
    expect(sched.departureSecs[0 * sched.stopCount + 0]).toBe(100); // trip 0, stop A
    expect(sched.departureSecs[0 * sched.stopCount + 1]).toBe(200); // trip 0, stop B
    expect(sched.departureSecs[1 * sched.stopCount + 0]).toBe(300); // trip 1, stop A
    expect(sched.departureSecs[1 * sched.stopCount + 1]).toBe(400); // trip 1, stop B
  });

  it("legacy -1 sentinel is translated to DEP_SECS_NOT_SERVED", () => {
    const identity = testIdentityWith({
      trips: ["t1"],
      services: ["svc"],
      headsigns: ["H"],
    });
    const view = buildRoutingView({
      routes: [
        {
          routeId: "R1",
          stopIds: ["A", "B", "C"],
          trips: [
            { tripId: "t1", serviceId: "svc", headsign: "H", departureSecs: [100, -1, 300] },
          ],
        },
      ],
    }, identity);

    const sched = view.getRouteSchedule("R1")!;
    expect(sched.departureSecs[0]).toBe(100);
    expect(sched.departureSecs[1]).toBe(DEP_SECS_NOT_SERVED);
    expect(sched.departureSecs[2]).toBe(300);
  });

  it("ix values resolve via Identity tables", () => {
    const identity = testIdentityWith({
      trips: ["t1", "t2"],
      services: ["svcA", "svcB"],
      headsigns: ["Downtown", "Airport"],
    });
    const view = buildRoutingView({
      routes: [
        {
          routeId: "R1",
          stopIds: ["A"],
          trips: [
            { tripId: "t1", serviceId: "svcA", headsign: "Downtown", departureSecs: [0] },
            { tripId: "t2", serviceId: "svcB", headsign: "Airport", departureSecs: [60] },
          ],
        },
      ],
    }, identity);

    const sched = view.getRouteSchedule("R1")!;
    expect(identity.trips.valueAt(sched.tripIx[0]!)).toBe("t1");
    expect(identity.trips.valueAt(sched.tripIx[1]!)).toBe("t2");
    expect(identity.services.valueAt(sched.serviceIx[0]!)).toBe("svcA");
    expect(identity.services.valueAt(sched.serviceIx[1]!)).toBe("svcB");
    expect(identity.headsigns.valueAt(sched.headsignIx[0]!)).toBe("Downtown");
    expect(identity.headsigns.valueAt(sched.headsignIx[1]!)).toBe("Airport");
  });

  it("getRouteStopIds returns the route's stopIds", () => {
    const identity = testIdentityWith({ trips: ["t1"], services: ["s"], headsigns: ["h"] });
    const view = buildRoutingView({
      routes: [
        {
          routeId: "R1",
          stopIds: ["A", "B", "C"],
          trips: [{ tripId: "t1", serviceId: "s", headsign: "h", departureSecs: [0, 60, 120] }],
        },
      ],
    }, identity);
    expect(view.getRouteStopIds("R1")).toEqual(["A", "B", "C"]);
  });

  it("getRouteSchedule(unknownRouteId) returns undefined", () => {
    const identity = emptyTestIdentity();
    const view = buildRoutingView({ routes: [] }, identity);
    expect(view.getRouteSchedule("nope")).toBeUndefined();
  });

  it("empty route (zero trips) produces zero-length typed arrays", () => {
    const identity = emptyTestIdentity();
    const view = buildRoutingView({
      routes: [{ routeId: "R1", stopIds: ["A"], trips: [] }],
    }, identity);
    const sched = view.getRouteSchedule("R1")!;
    expect(sched.tripCount).toBe(0);
    expect(sched.tripIx.length).toBe(0);
    expect(sched.departureSecs.length).toBe(0);
  });

  it("iterRoutes yields (routeId, schedule) for every route", () => {
    const identity = testIdentityWith({ trips: ["t1"], services: ["s"], headsigns: ["h"] });
    const view = buildRoutingView({
      routes: [
        { routeId: "R1", stopIds: ["A"], trips: [{ tripId: "t1", serviceId: "s", headsign: "h", departureSecs: [0] }] },
        { routeId: "R2", stopIds: ["B"], trips: [] },
      ],
    }, identity);

    const seen: Array<[string, number]> = [];
    view.iterRoutes((routeId, sched) => {
      seen.push([routeId, sched.tripCount]);
    });
    expect(seen).toEqual([["R1", 1], ["R2", 0]]);
  });

  it("throws if a trip references an unknown tripId (build-time invariant)", () => {
    const identity = testIdentityWith({
      trips: ["t1"], // "ghost" is NOT in the intern table
      services: ["s"],
      headsigns: ["h"],
    });
    expect(() => buildRoutingView({
      routes: [{ routeId: "R1", stopIds: ["A"], trips: [{ tripId: "ghost", serviceId: "s", headsign: "h", departureSecs: [0] }] }],
    }, identity)).toThrow(/unknown trip_id.*ghost/);
  });

  it("throws if a trip references an unknown serviceId (build-time invariant)", () => {
    const identity = testIdentityWith({
      trips: ["t1"],
      services: ["s"], // "unknown-svc" is NOT in the intern table
      headsigns: ["h"],
    });
    expect(() => buildRoutingView({
      routes: [{ routeId: "R1", stopIds: ["A"], trips: [{ tripId: "t1", serviceId: "unknown-svc", headsign: "h", departureSecs: [0] }] }],
    }, identity)).toThrow(/unknown service_id.*unknown-svc/);
  });

  it("throws if a trip references an unknown headsign (build-time invariant)", () => {
    const identity = testIdentityWith({
      trips: ["t1"],
      services: ["s"],
      headsigns: ["h"], // "ghost-sign" is NOT in the intern table
    });
    expect(() => buildRoutingView({
      routes: [{ routeId: "R1", stopIds: ["A"], trips: [{ tripId: "t1", serviceId: "s", headsign: "ghost-sign", departureSecs: [0] }] }],
    }, identity)).toThrow(/unknown headsign.*ghost-sign/);
  });

  it("canonicalizes empty directionPatterns input to undefined on the output schedule", () => {
    // Input: route with directionPatterns: []. Producers and consumers
    // agreed to use undefined as the single canonical form for "no
    // patterns" — empty array must not survive the boundary.
    const identity = testIdentityWith({
      trips: ["t1"],
      services: ["s"],
      headsigns: ["h"],
    });
    const view = buildRoutingView({
      routes: [{
        routeId: "R1",
        stopIds: ["A"],
        trips: [{ tripId: "t1", serviceId: "s", headsign: "h", departureSecs: [0] }],
        directionPatterns: [],
      }],
    }, identity);

    const sched = view.getRouteSchedule("R1");
    expect(sched).toBeDefined();
    expect(sched!.directionPatterns).toBeUndefined();
  });

  it("repeated routeId (Unbounded patterns): iterRoutes emits the id twice and routeCount === 2", () => {
    // Two pattern-records sharing one routeId (different stopIds) — the
    // Unbounded per-pattern wire format. iterRoutes must yield the id for
    // each record; routeCount reflects the total number of pattern-records,
    // not the number of unique route_ids; uniqueRouteCount reflects the
    // unique count.
    const identity = testIdentityWith({
      trips: ["t1", "t2"],
      services: ["svc"],
      headsigns: ["North", "South"],
    });
    const view = buildRoutingView({
      routes: [
        {
          routeId: "R1",
          stopIds: ["A", "B"],
          trips: [{ tripId: "t1", serviceId: "svc", headsign: "North", departureSecs: [0, 60] }],
        },
        {
          routeId: "R1",
          stopIds: ["B", "C"],
          trips: [{ tripId: "t2", serviceId: "svc", headsign: "South", departureSecs: [120, 180] }],
        },
      ],
    }, identity);

    expect(view.routeCount).toBe(2);
    expect(view.uniqueRouteCount).toBe(1);

    const seen: Array<[string, string[]]> = [];
    view.iterRoutes((routeId, sched) => {
      seen.push([routeId, [...sched.stopIds]]);
    });
    expect(seen).toEqual([
      ["R1", ["A", "B"]],
      ["R1", ["B", "C"]],
    ]);
  });

  it("preserves non-empty directionPatterns through to the output schedule", () => {
    const identity = testIdentityWith({
      trips: ["t1"],
      services: ["s"],
      headsigns: ["h"],
    });
    const view = buildRoutingView({
      routes: [{
        routeId: "R1",
        stopIds: ["A", "B"],
        trips: [{ tripId: "t1", serviceId: "s", headsign: "h", departureSecs: [0, 60] }],
        directionPatterns: [
          { key: "0", headsign: "h", stopIds: ["A", "B"] },
        ],
      }],
    }, identity);

    const sched = view.getRouteSchedule("R1");
    expect(sched!.directionPatterns).toEqual([
      { key: "0", headsign: "h", stopIds: ["A", "B"] },
    ]);
  });
});
