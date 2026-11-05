import { describe, expect, it } from "vitest";
import { ARRIVE_BY_SELECTORS, type ArriveBySelector } from "./temporalArriveByResults.ts";
import {
  ARRIVE_BY_CONNECTION_KINDS, composeArriveByJourney, decodeArriveByJourneys,
  type ArriveByMovementScope,
} from "./temporalArriveByJourneys.ts";

const SCOPE: ArriveByMovementScope = {
  serviceDate: 20261012, windowStart: -300, windowEnd: 1001, arrivalDeadline: 1000, maxRounds: 4,
  entryStops: [{ stopId: "A", walkSecs: 60 }, { stopId: "A", walkSecs: 10 }],
  exitStops: [{ stopId: "X", walkSecs: 40 }],
};
function journey() {
  const witness = [{ serviceDate: 20261011, routeIdx: 3, readerRouteIdx: 1, tripIdx: 4,
    boardPosition: 0, alightPosition: 2, boardSecs: -140, alightSecs: 100,
    frequencyOffsetSecs: 86400, frequencyInstance: false, inSeat: false },
  { serviceDate: 20261012, routeIdx: 6, readerRouteIdx: 2, tripIdx: 8,
    boardPosition: 0, alightPosition: 1, boardSecs: 300, alightSecs: 500,
    frequencyOffsetSecs: 0, frequencyInstance: true, inSeat: false }];
  return {
    point: { departureSecs: -200, arrivalSecs: 570, totalWalkSecs: 150, actualTransfers: 1,
      transitRounds: 2, serviceDate: 20261012, witnessLegs: 2, witness },
    access: { stopId: "A", walkSecs: 60 },
    rides: witness.map((w, i) => ({ witness: structuredClone(w), routeId: `route${i}`,
      routeShortName: `${i}`, routeColor: i === 0 ? "123456" : null, tripId: `trip${i}`,
      mode: "BUS", routeType: 3, fromStopId: i === 0 ? "A" : "B", toStopId: i === 0 ? "A" : "C",
      patternStopIds: i === 0 ? ["A", "B", "A"] : ["B", "C"], approximate: w.frequencyInstance })),
    connections: [{ fromStopId: "A", toStopId: "B", arrivalSecs: 100, boardingSecs: 300,
      walkSecs: 20, minimumElapsedSecs: 100, kind: "footpath", spendsTransfer: true }],
    egress: { fromStopId: "C", exitStopId: "X", physicalWalkSecs: 30, callerWalkSecs: 40 },
  };
}
type Journey = ReturnType<typeof journey>;
function report(j: Journey | null = journey(), goal: ArriveBySelector | "portfolio" = "portfolio") {
  const selectors = goal === "portfolio" ? ARRIVE_BY_SELECTORS : [goal];
  return {
    scope: "deadline-winner-session-wasm-experiment", contract: "lexicographic-filter-winners-v1-no-arrival-floor",
    complete: true, queryKind: goal, completionScope: goal === "portfolio" ? "fixed-selectors-only" : "single-selector-only",
    requestedWindow: [SCOPE.windowStart, SCOPE.windowEnd], arrivalDeadline: SCOPE.arrivalDeadline,
    winners: Object.fromEntries(selectors.map((s) => [s, j ? structuredClone(j.point) : null])),
    journeyContract: "complete-selected-movement-v1", journeys: j ? [j] : [],
    journeyByPreference: Object.fromEntries(selectors.map((s) => [s, j ? 0 : null])),
    // Not interpreted as legality/work proof by the UI decoder.
    counters: { futureDiagnostic: true }, movementMs: 1,
  };
}
type Report = ReturnType<typeof report>;
const decode = (r: unknown) => decodeArriveByJourneys(r, SCOPE, "portfolio");

describe("complete arrive-by movement boundary", () => {
  it("owns frozen movement, full canonical identity and all selector labels", () => {
    const raw = report(), before = structuredClone(raw);
    const options = decode(raw), option = options[0]!;
    expect(options).toHaveLength(1);
    expect(option.selectors).toEqual(ARRIVE_BY_SELECTORS);
    expect(option.journey).toEqual(raw.journeys[0]);
    expect(raw).toEqual(before);
    raw.journeys[0]!.rides[0]!.patternStopIds[0] = "changed";
    raw.journeys[0]!.point.witness[0]!.tripIdx++;
    expect(option.journey.rides[0]!.patternStopIds).toEqual(["A", "B", "A"]);
    expect(option.journey.point.witness[0]!.tripIdx).toBe(4);
    for (const value of [options, option, option.selectors, option.journey, option.journey.access,
      option.journey.rides, option.journey.rides[0], option.journey.rides[0]!.witness,
      option.journey.rides[0]!.patternStopIds, option.journey.connections,
      option.journey.connections[0], option.journey.egress]) expect(Object.isFrozen(value)).toBe(true);
  });

  it.each(ARRIVE_BY_SELECTORS)("decodes only the requested single selector: %s", (goal) => {
    const options = decodeArriveByJourneys(report(journey(), goal), SCOPE, goal);
    expect(options[0]!.selectors).toEqual([goal]);
    const raw = report(journey(), goal);
    raw.journeyByPreference.extra = null;
    expect(() => decodeArriveByJourneys(raw, SCOPE, goal)).toThrow();
  });

  it("accepts genuine empty completion, not a failure or incomplete certificate", () => {
    expect(decode(report(null))).toEqual([]);
    expect(() => decode({ status: "failed", error: "WorkExhausted" })).toThrow();
    expect(() => decode({ ...report(), complete: false })).toThrow();
    expect(() => decode({ ...report(), journeyContract: "other" })).toThrow();
    const raw = report(null);
    raw.journeys.push(journey());
    expect(() => decode(raw)).toThrow(/unselected/);
  });

  it.each(ARRIVE_BY_CONNECTION_KINDS)("retains %s, elapsed time and passenger-transfer semantics", (kind) => {
    const j = journey(), c = j.connections[0]!;
    c.kind = kind;
    c.spendsTransfer = kind !== "in-seat" && kind !== "derived";
    j.point.actualTransfers = Number(c.spendsTransfer);
    j.point.witness[1]!.inSeat = j.rides[1]!.witness.inSeat = !c.spendsTransfer;
    if (kind === "same-stop") {
      c.toStopId = j.rides[1]!.fromStopId = j.rides[1]!.patternStopIds[0] = "A";
      c.walkSecs = 0; j.point.totalWalkSecs -= 20;
    }
    const option = decode(report(j))[0]!;
    expect(option.journey.connections[0]).toEqual(c);
    const segment = composeArriveByJourney(option).timeline[2]!;
    expect(segment.kind).toBe("connection");
    expect(segment.arrivalSecs - segment.departureSecs).toBe(200);
    expect(option.journey.point.actualTransfers).toBe(Number(c.spendsTransfer));
    // Neither the transfer floor nor the full gap becomes physical walking.
    expect(option.journey.point.totalWalkSecs).toBe(kind === "same-stop" ? 130 : 150);
  });

  it("preserves previous-day rides, repeated occurrences and both frequency identities", () => {
    const j = decode(report())[0]!.journey;
    expect(j.rides[0]!.witness.serviceDate).toBe(20261011);
    expect(j.rides[0]!.fromStopId).toBe(j.rides[0]!.toStopId);
    expect(j.rides[0]!.witness.alightPosition).toBe(2);
    expect(j.rides[0]!.witness.frequencyOffsetSecs).toBe(86400);
    expect(j.rides[0]!.approximate).toBe(false);
    expect(j.rides[1]!.approximate).toBe(true);
  });

  it("uses each winner's departure and retains a complete contiguous timeline", () => {
    const raw = report(), second = journey();
    second.point.departureSecs -= 10; second.point.arrivalSecs -= 10;
    for (const w of second.point.witness) { w.boardSecs -= 10; w.alightSecs -= 10; }
    for (const r of second.rides) { r.witness.boardSecs -= 10; r.witness.alightSecs -= 10; }
    second.connections[0]!.arrivalSecs -= 10; second.connections[0]!.boardingSecs -= 10;
    raw.journeys.push(second); raw.journeyByPreference.fastest = 1;
    raw.winners.fastest = structuredClone(second.point);
    const options = decode(raw), presentations = options.map(composeArriveByJourney);
    expect(options).toHaveLength(2);
    expect(options[1]!.selectors).toEqual(["fastest"]);
    expect(presentations.map((p) => p.departureSecs)).toEqual([-200, -210]);
    expect(presentations.map((p) => p.arrivalSecs)).toEqual([570, 560]);
    for (const p of presentations) {
      expect(p.totalSecs).toBe(770); expect(p.totalWalkSecs).toBe(150); expect(p.transfers).toBe(1);
      expect(p.timeline.map((s) => s.kind)).toEqual(["access", "ride", "connection", "ride", "physical-egress", "caller-egress"]);
      expect(p.timeline[0]!.departureSecs).toBe(p.departureSecs);
      expect(p.timeline.at(-1)!.arrivalSecs).toBe(p.arrivalSecs);
      p.timeline.forEach((s, i) => {
        expect(s.arrivalSecs).toBeGreaterThanOrEqual(s.departureSecs);
        if (i) expect(s.departureSecs).toBe(p.timeline[i - 1]!.arrivalSecs);
        expect(Object.isFrozen(s)).toBe(true);
      });
      expect(Object.isFrozen(p)).toBe(true); expect(Object.isFrozen(p.timeline)).toBe(true);
    }
  });

  it("allows caller egress after the controlled 48-hour horizon", () => {
    const j = journey(), last = j.point.departureSecs + 172800;
    j.point.witness[1]!.alightSecs = j.rides[1]!.witness.alightSecs = last - 30;
    j.point.arrivalSecs = last + 40;
    const r = report(j); r.arrivalDeadline = last + 40;
    expect(decodeArriveByJourneys(r, { ...SCOPE, arrivalDeadline: last + 40 }, "portfolio")).toHaveLength(1);
    j.point.witness[1]!.alightSecs++;
    j.rides[1]!.witness.alightSecs++;
    j.point.arrivalSecs++;
    const bad = report(j); bad.arrivalDeadline = last + 41;
    expect(() => decodeArriveByJourneys(bad, { ...SCOPE, arrivalDeadline: last + 41 }, "portfolio")).toThrow(/physical egress outside/);
  });

  it("keeps zero-time movement segments and does not assume unique query stop IDs", () => {
    const j = journey();
    j.egress.exitStopId = "C"; j.egress.physicalWalkSecs = j.egress.callerWalkSecs = 0;
    j.access.walkSecs = 0; j.point.departureSecs = -140;
    j.point.arrivalSecs = 500; j.point.totalWalkSecs = 20;
    const options = decodeArriveByJourneys(report(j), { ...SCOPE,
      entryStops: [{ stopId: "A", walkSecs: 60 }, { stopId: "A", walkSecs: 0 }],
      exitStops: [{ stopId: "C", walkSecs: 0 }] }, "portfolio");
    const timeline = composeArriveByJourney(options[0]!).timeline;
    for (const s of [timeline[0]!, ...timeline.slice(-2)]) expect(s.arrivalSecs).toBe(s.departureSecs);
  });

  it.each([
    ["null journey", (r: Report) => { r.journeys[0] = null as unknown as Journey; }],
    ["no journey", (r: Report) => { r.journeys = []; }],
    ["mapping range", (r: Report) => { r.journeyByPreference.fastest = 1; }],
    ["mapping fraction", (r: Report) => { r.journeyByPreference.fastest = 0.5; }],
    ["mapping null", (r: Report) => { r.journeyByPreference.fastest = null; }],
    ["point mismatch", (r: Report) => { r.journeys[0]!.point.totalWalkSecs++; }],
    ["extra journey field", (r: Report) => { Object.assign(r.journeys[0]!, { future: 1 }); }],
    ["unselected journey", (r: Report) => { r.journeys.push(journey()); }],
    ["duplicate not shared", (r: Report) => { r.journeys.push(journey()); r.journeyByPreference.fastest = 1; }],
  ] as const)("fails closed: %s", (_name, mutate) => {
    const raw = report(); mutate(raw); expect(() => decode(raw)).toThrow();
  });

  it.each([
    ["access membership", (j: Journey) => { j.access.walkSecs = 61; }],
    ["access stop", (j: Journey) => { j.access.stopId = "B"; }],
    ["access type", (j: Journey) => { j.access.walkSecs = NaN; }],
    ["ride count", (j: Journey) => { j.rides.pop(); }],
    ["ride witness", (j: Journey) => { j.rides[0]!.witness.tripIdx++; }],
    ["witness extra", (j: Journey) => { Object.assign(j.rides[0]!.witness, { future: 1 }); }],
    ["pattern occurrence", (j: Journey) => { j.rides[0]!.patternStopIds.pop(); }],
    ["pattern metadata", (j: Journey) => { j.rides[0]!.patternStopIds[0] = null as unknown as string; }],
    ["trip metadata", (j: Journey) => { j.rides[0]!.tripId = 1 as unknown as string; }],
    ["mode", (j: Journey) => { j.rides[0]!.mode = "WALK"; }],
    ["route type", (j: Journey) => { j.rides[0]!.routeType = 65536; }],
    ["color", (j: Journey) => { j.rides[0]!.routeColor = false as unknown as string; }],
    ["approximation", (j: Journey) => { j.rides[0]!.approximate = true; }],
    ["connection count", (j: Journey) => { j.connections = []; }],
    ["connection direction", (j: Journey) => { j.connections[0]!.fromStopId = "B"; }],
    ["connection boarding", (j: Journey) => { j.connections[0]!.boardingSecs++; }],
    ["connection arrival", (j: Journey) => { j.connections[0]!.arrivalSecs--; }],
    ["connection kind", (j: Journey) => { j.connections[0]!.kind = "unknown"; }],
    ["transfer", (j: Journey) => { j.connections[0]!.spendsTransfer = false; }],
    ["walking floor", (j: Journey) => { j.connections[0]!.minimumElapsedSecs = 19; }],
    ["transfer floor", (j: Journey) => { j.connections[0]!.minimumElapsedSecs = 201; }],
    ["same-stop walk", (j: Journey) => { j.connections[0]!.kind = "same-stop"; }],
    ["negative walk", (j: Journey) => { j.connections[0]!.walkSecs = -1; }],
    ["unsafe elapsed", (j: Journey) => { j.connections[0]!.minimumElapsedSecs = Number.MAX_SAFE_INTEGER + 1; }],
    ["egress origin", (j: Journey) => { j.egress.fromStopId = "A"; }],
    ["egress membership", (j: Journey) => { j.egress.exitStopId = "Y"; }],
    ["egress arrival", (j: Journey) => { j.egress.physicalWalkSecs++; }],
    ["walk total", (j: Journey) => { j.point.totalWalkSecs--; }],
    ["unsafe sum", (j: Journey) => { j.egress.physicalWalkSecs = Number.MAX_SAFE_INTEGER; }],
  ] as const)("rejects %s movement", (_name, mutate) => {
    const j = journey(); mutate(j); expect(() => decode(report(j))).toThrow();
  });
});
