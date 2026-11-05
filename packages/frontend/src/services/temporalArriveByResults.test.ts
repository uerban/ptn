import { describe, expect, it } from "vitest";
import {
  ARRIVE_BY_SELECTORS, ArriveByResultSession, decodeArriveByWinners,
  type ArriveByFailure, type ArriveByReply, type ArriveByScope,
} from "./temporalArriveByResults.ts";

const SCOPE: ArriveByScope = {
  serviceDate: 20261012, windowStart: -7200, windowEnd: 36001,
  arrivalDeadline: 36000, maxRounds: 4,
};

function point() {
  return {
    departureSecs: 30000, arrivalSecs: 35000, actualTransfers: 0,
    totalWalkSecs: 120, transitRounds: 1, serviceDate: 20261012, witnessLegs: 1,
    witness: [{
      serviceDate: 20261012, routeIdx: 3, readerRouteIdx: 2, tripIdx: 5,
      boardPosition: 1, alightPosition: 7, boardSecs: 30060, alightSecs: 34940,
      frequencyOffsetSecs: 0, frequencyInstance: false, inSeat: false,
    }],
  };
}

type Point = ReturnType<typeof point>;
function report(goal: "latest-departure" | "portfolio" = "portfolio", p: Point | null = point()) {
  return {
    scope: "deadline-winner-session-wasm-experiment",
    contract: "lexicographic-filter-winners-v1-no-arrival-floor",
    complete: true,
    completionScope: goal === "portfolio" ? "fixed-selectors-only" : "single-selector-only",
    queryKind: goal, requestedWindow: [SCOPE.windowStart, SCOPE.windowEnd],
    arrivalDeadline: SCOPE.arrivalDeadline,
    winners: Object.fromEntries((goal === "portfolio" ? ARRIVE_BY_SELECTORS : ["latest-departure"]).map((s) => [s, structuredClone(p)])),
    // Diagnostics may grow; they are not consumed as a routing/work proof.
    counters: { untouched: true },
  };
}

function session(sequence: "portfolio" | "latest-then-portfolio" = "portfolio") {
  return new ArriveByResultSession(7, 2, SCOPE, sequence);
}

function reply(result = report(), kind: "latest" | "complete" = "complete"): ArriveByReply & { kind: "latest" | "complete" } {
  return { requestId: 7, generation: 2, kind, result };
}

describe("arrive-by result contract", () => {
  it("decodes and owns all four exact canonical points without mutating the report", () => {
    const raw = report();
    const before = structuredClone(raw);
    const decoded = decodeArriveByWinners(raw, SCOPE, "portfolio");
    expect(decoded["latest-departure"]).toEqual(point());
    expect(Object.keys(decoded)).toEqual(ARRIVE_BY_SELECTORS);
    expect(raw).toEqual(before);
    raw.winners.fastest!.witness[0]!.tripIdx = 999;
    expect(decoded.fastest!.witness[0]!.tripIdx).toBe(5);
    expect(Object.isFrozen(decoded.fastest!.witness[0])).toBe(true);
    expect(Object.isFrozen(decoded.fastest!.witness)).toBe(true);
    expect(Object.isFrozen(decoded.fastest)).toBe(true);
  });

  it("does not add a now cutoff or arrival band, and permits a different leg service date", () => {
    const p = point();
    Object.assign(p, { departureSecs: -7100, arrivalSecs: 1000, totalWalkSecs: 0 });
    Object.assign(p.witness[0]!, { serviceDate: 20261011, boardSecs: -7100, alightSecs: 1000 });
    expect(decodeArriveByWinners(report("portfolio", p), SCOPE, "portfolio").fastest).toEqual(p);
  });

  it("accepts zero-round empty results, not a partial set of empty selectors", () => {
    const empty = decodeArriveByWinners(report("portfolio", null), { ...SCOPE, maxRounds: 0 }, "portfolio");
    expect(Object.values(empty)).toEqual([null, null, null, null]);
    const partial = report();
    partial.winners.fastest = null;
    expect(() => decodeArriveByWinners(partial, SCOPE, "portfolio")).toThrow(/empty selectors/);
  });

  it("counts in-seat continuations as a transit round but not a passenger transfer", () => {
    const p = point();
    p.witness[0]!.alightSecs = 31000;
    p.witness.push({ ...p.witness[0]!, tripIdx: 6, boardSecs: 31000, alightSecs: 34940, inSeat: true });
    p.transitRounds = p.witnessLegs = 2;
    expect(decodeArriveByWinners(report("portfolio", p), SCOPE, "portfolio").fastest!.actualTransfers).toBe(0);
    p.witness[1]!.inSeat = false;
    expect(() => decodeArriveByWinners(report("portfolio", p), SCOPE, "portfolio")).toThrow(/passenger transfer/);
    p.actualTransfers = 1;
    expect(decodeArriveByWinners(report("portfolio", p), SCOPE, "portfolio").fastest!.actualTransfers).toBe(1);
  });

  it.each([
    ["incomplete", { complete: false }],
    ["profile", { completionScope: "skyline" }],
    ["wrong selector", { queryKind: "latest-departure" }],
    ["old schema", { contract: "other" }],
    ["wrong scope", { scope: "other" }],
    ["window", { requestedWindow: [0, SCOPE.windowEnd] }],
    ["deadline", { arrivalDeadline: 36001 }],
  ])("rejects %s reports", (_name, patch) => {
    expect(() => decodeArriveByWinners({ ...report(), ...patch }, SCOPE, "portfolio")).toThrow();
  });

  it.each([null, [], "result", {}, { ...report(), winners: new Map() }])("rejects malformed result %j", (r) => {
    expect(() => decodeArriveByWinners(r, SCOPE, "portfolio")).toThrow();
  });

  it("requires explicit nulls and the exact requested selector keys", () => {
    const raw = report();
    delete raw.winners.fastest;
    expect(() => decodeArriveByWinners(raw, SCOPE, "portfolio")).toThrow(/fields/);
    raw.winners.fastest = undefined as unknown as null;
    expect(() => decodeArriveByWinners(raw, SCOPE, "portfolio")).toThrow();
    const extra = report("latest-departure");
    extra.winners.fastest = point();
    expect(() => decodeArriveByWinners(extra, SCOPE, "latest-departure")).toThrow(/fields/);
  });

  it.each([
    ["unsafe walk", (p: Point) => { p.totalWalkSecs = Number.MAX_SAFE_INTEGER + 1; }],
    ["negative walk", (p: Point) => { p.totalWalkSecs = -1; }],
    ["fraction", (p: Point) => { p.departureSecs = 1.5; }],
    ["NaN", (p: Point) => { p.arrivalSecs = NaN; }],
    ["wrong date", (p: Point) => { p.serviceDate = 20261013; }],
    ["window end", (p: Point) => { p.departureSecs = SCOPE.windowEnd; }],
    ["window start", (p: Point) => { p.departureSecs = SCOPE.windowStart - 1; }],
    ["late arrival", (p: Point) => { p.arrivalSecs = SCOPE.arrivalDeadline + 1; }],
    ["inverted times", (p: Point) => { p.arrivalSecs = p.departureSecs - 1; }],
    ["impossible walking", (p: Point) => { p.totalWalkSecs = 5001; }],
    ["witness count", (p: Point) => { p.witnessLegs = 2; }],
    ["round count", (p: Point) => { p.transitRounds = 2; }],
    ["first continuation", (p: Point) => { p.witness[0]!.inSeat = true; }],
    ["position", (p: Point) => { p.witness[0]!.alightPosition = 1; }],
    ["index", (p: Point) => { p.witness[0]!.tripIdx = 2 ** 32; }],
    ["early boarding", (p: Point) => { p.witness[0]!.boardSecs = p.departureSecs - 1; }],
    ["late alighting", (p: Point) => { p.witness[0]!.alightSecs = p.arrivalSecs + 1; }],
    ["empty witness", (p: Point) => { p.witness = []; }],
    ["new canonical field", (p: Point) => { Object.assign(p.witness[0]!, { newIdentity: 1 }); }],
    ["new point field", (p: Point) => { Object.assign(p, { newIdentity: 1 }); }],
    ["flag type", (p: Point) => { Object.assign(p.witness[0]!, { frequencyInstance: 1 }); }],
  ])("rejects %s without coercion", (_name, mutate) => {
    const p = point();
    mutate(p);
    expect(() => decodeArriveByWinners(report("portfolio", p), SCOPE, "portfolio")).toThrow();
  });

  it("rejects a witness beyond the request round cap", () => {
    expect(() => decodeArriveByWinners(report(), { ...SCOPE, maxRounds: 0 }, "portfolio")).toThrow(/length/);
  });

  it.each([
    { windowStart: SCOPE.windowEnd }, { windowEnd: 36002 }, { maxRounds: 5 },
    { maxRounds: -1 }, { serviceDate: -1 }, { windowStart: -Infinity },
  ])("rejects invalid request scope %j", (patch) => {
    expect(() => new ArriveByResultSession(7, 2, { ...SCOPE, ...patch }, "portfolio")).toThrow();
  });
});

describe("arrive-by request result lifecycle", () => {
  it("merges full-identical winners and retains all labels in latest-first order", () => {
    const s = session();
    expect(s.snapshot).toEqual({ status: "pending", options: [], failure: null });
    expect(s.accept(reply())).toBe(true);
    expect(s.snapshot.status).toBe("complete");
    expect(s.snapshot.options).toHaveLength(1);
    expect(s.snapshot.options[0]!.selectors).toEqual(ARRIVE_BY_SELECTORS);
    expect(Object.isFrozen(s.snapshot.options[0]!.selectors)).toBe(true);
  });

  it.each([
    "serviceDate", "routeIdx", "readerRouteIdx", "tripIdx", "boardPosition", "alightPosition",
    "boardSecs", "alightSecs", "frequencyOffsetSecs", "frequencyInstance",
  ] as const)("does not merge a differing canonical witness field: %s", (field) => {
    const r = report();
    const w = r.winners.fastest!.witness[0]!;
    if (field === "frequencyInstance") w[field] = true;
    else w[field]++;
    const s = session();
    s.accept(reply(r));
    expect(s.snapshot.status).toBe("complete");
    expect(s.snapshot.options).toHaveLength(2);
    expect(s.snapshot.options[1]!.selectors).toEqual(["fastest"]);
  });

  it("does not depend on object insertion order for duplicate identity", () => {
    const r = report();
    r.winners.fastest = Object.fromEntries(Object.entries(r.winners.fastest!).reverse()) as Point;
    r.winners.fastest.witness[0] = Object.fromEntries(Object.entries(r.winners.fastest.witness[0]!).reverse()) as Point["witness"][number];
    const s = session();
    s.accept(reply(r));
    expect(s.snapshot.options).toHaveLength(1);
  });

  it("does not merge equal transit witnesses with differing complete-point walking", () => {
    const r = report();
    r.winners.fastest!.totalWalkSecs++;
    const s = session();
    s.accept(reply(r));
    expect(s.snapshot.status).toBe("complete");
    expect(s.snapshot.options).toHaveLength(2);
  });

  it("does not mistake latest-only certification for four-selector completion", () => {
    const s = session("latest-then-portfolio");
    s.accept(reply(report("latest-departure"), "latest"));
    expect(s.snapshot.status).toBe("latest");
    expect(s.snapshot.options[0]!.selectors).toEqual(["latest-departure"]);
    const first = s.snapshot;
    s.accept(reply());
    expect(s.snapshot.status).toBe("complete");
    expect(first.status).toBe("latest");
    expect(first.options[0]!.selectors).toEqual(["latest-departure"]);
  });

  it("empty latest-only output is not an empty completed portfolio", () => {
    const s = session("latest-then-portfolio");
    s.accept(reply(report("latest-departure", null), "latest"));
    expect(s.snapshot.status).toBe("latest");
    expect(s.snapshot.options).toEqual([]);
    s.accept(reply(report("portfolio", null)));
    expect(s.snapshot.status).toBe("complete");
  });

  it.each(["different witness", "empty/nonempty"])("fails closed if stages disagree: %s", (mode) => {
    const s = session("latest-then-portfolio");
    s.accept(reply(report("latest-departure"), "latest"));
    const r = report();
    if (mode === "different witness") r.winners["latest-departure"]!.witness[0]!.tripIdx++;
    else for (const k of ARRIVE_BY_SELECTORS) r.winners[k] = null;
    s.accept(reply(r));
    expect(s.snapshot.status).toBe("failed");
    expect(s.snapshot.options).toEqual([]);
    expect(s.snapshot.failure?.stage).toBe("contract");
  });

  it("ignores stale results AND errors before touching their malformed payloads", () => {
    const s = session();
    expect(s.accept({ ...reply(), requestId: 8, result: null })).toBe(false);
    expect(s.accept({ ...reply(), generation: 3, result: null })).toBe(false);
    expect(s.accept({ requestId: 6, generation: 2, kind: "failed", failure: null as unknown as ArriveByFailure })).toBe(false);
    expect(s.snapshot.status).toBe("pending");
    s.accept(reply());
    expect(s.snapshot.status).toBe("complete");
  });

  it.each([false, true])("cancels with latest already delivered=%s; never revives", (latest) => {
    const s = session("latest-then-portfolio");
    if (latest) s.accept(reply(report("latest-departure"), "latest"));
    s.cancel();
    s.cancel();
    expect(s.snapshot).toEqual({ status: "cancelled", options: [], failure: null });
    expect(s.accept(reply())).toBe(false);
  });

  it("a current typed exhaustion clears earlier output, preserving its code/stage", () => {
    const s = session("latest-then-portfolio");
    s.accept(reply(report("latest-departure"), "latest"));
    const failure: ArriveByFailure = { stage: "search", code: "WorkExhausted", message: "lookup cap" };
    s.accept({ requestId: 7, generation: 2, kind: "failed", failure });
    expect(s.snapshot).toEqual({ status: "failed", options: [], failure });
    expect(s.snapshot.failure).not.toBe(failure);
    expect(s.accept(reply())).toBe(false);
  });

  it("keeps a completed latest selector after a structured limit without completing portfolio", () => {
    const s = session("latest-then-portfolio");
    s.accept(reply(report("latest-departure"), "latest"));
    const options = s.snapshot.options;
    const failure: ArriveByFailure = { stage: "search", code: "ResourceLimit", resourceLimit: "lookup-work", message: "cap" };
    s.accept({ requestId: 7, generation: 2, kind: "failed", failure });
    expect(s.snapshot).toEqual({ status: "limited", options, failure });
    expect(s.accept(reply())).toBe(false);
    s.cancel(); expect(s.snapshot).toMatchObject({ status: "cancelled", options: [] });
  });

  it("does not coerce malformed failure stages", () => {
    const s = session();
    const failure = { stage: ["search"], code: "WorkExhausted", message: "cap" } as unknown as ArriveByFailure;
    s.accept({ requestId: 7, generation: 2, kind: "failed", failure });
    expect(s.snapshot.failure?.code).toBe("InvalidWinnerResult");
  });

  it.each(["portfolio receives latest", "final before latest", "duplicate latest", "bad result", "bad failure"])("rejects current protocol violation: %s", (mode) => {
    const s = session(mode === "portfolio receives latest" ? "portfolio" : "latest-then-portfolio");
    if (mode === "duplicate latest" || mode === "bad result") s.accept(reply(report("latest-departure"), "latest"));
    if (mode === "bad failure") s.accept({ requestId: 7, generation: 2, kind: "failed", failure: {} as ArriveByFailure });
    else if (mode === "bad result") s.accept(reply({ ...report(), complete: false }));
    else s.accept(reply(mode === "final before latest" ? report() : report("latest-departure"), mode === "final before latest" ? "complete" : "latest"));
    expect(s.snapshot.status).toBe("failed");
    expect(s.snapshot.options).toEqual([]);
  });

  it("complete is terminal, including late failures/cancellation", () => {
    const s = session();
    s.accept(reply());
    const final = s.snapshot;
    expect(s.accept({ requestId: 7, generation: 2, kind: "failed", failure: {} as ArriveByFailure })).toBe(false);
    s.cancel();
    expect(s.snapshot).toBe(final);
  });

  it("owns the expected scope instead of observing caller mutation", () => {
    const scope = { ...SCOPE };
    const s = new ArriveByResultSession(7, 2, scope, "portfolio");
    scope.windowStart = 0;
    s.accept(reply());
    expect(s.snapshot.status).toBe("complete");
  });
});
