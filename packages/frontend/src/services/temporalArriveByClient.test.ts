import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArriveByOwnerHost, type ArriveByOwnerWorkerReply, type ArriveByOwnerWorkerRequest } from "./ptArriveByOwnerHost.ts";
import { createPtRouterHost, type PtRouterReply, type PtRouterRequest, type PtWasmModule } from "./ptRouterWorkerHost.ts";
import { createArriveByFeature } from "./temporalArriveByFeature.ts";
import {
  arriveByScope, createArriveByChannel, type ArriveBySearchInput, type ArriveBySearchState, type ArriveByWireRequest,
} from "./temporalArriveByClient.ts";
import type { ArriveByOwnerRequest } from "./temporalArriveByOwner.ts";
import { ARRIVE_BY_SELECTORS } from "./temporalArriveByResults.ts";

// The handle tests below start the opt-in workers; the hoisted holder lets the
// mocked entry reach the fake workers defined further down.
const hoisted = vi.hoisted(() => ({
  makeRouterWorker: null as null | (() => unknown),
  makeOwnerWorker: null as null | (() => unknown),
}));
vi.mock("./ptRouterWorkerEntry.ts", async () => {
  const { createArriveByLink: create } = await import("./temporalArriveByLink.ts");
  return {
    ROUTER_WORKER_KIND: "arrive-by",
    createRouterWorker: () => hoisted.makeRouterWorker!(),
    createArriveByLink: (bundle: Parameters<typeof create>[1]) => create(() => hoisted.makeOwnerWorker!() as Worker, bundle),
  };
});
import { buildPtRouter } from "./raptorWasm.ts";

const SCOPE = { serviceDate: 20261012, windowStart: -300, windowEnd: 1001, arrivalDeadline: 1000, maxRounds: 4,
  entryStops: [{ stopId: "A", walkSecs: 60 }], exitStops: [{ stopId: "X", walkSecs: 40 }] };
const INPUT: ArriveBySearchInput = {
  scope: SCOPE, mobilityProfile: "default", excludedModes: [], walkSpeedMps: 1.25, minTransferSecs: 120,
};
const OTHER: ArriveBySearchInput = { ...INPUT, scope: { ...SCOPE, exitStops: [{ stopId: "X", walkSecs: 50 }] } };

// --- a fake deadline probe, shaped like the WASM one -------------------------
function output(goal: string, empty: boolean, window: readonly [number, number]) {
  const witness = { serviceDate: 20261011, routeIdx: 1, readerRouteIdx: 2, tripIdx: 3, boardPosition: 0,
    alightPosition: 1, boardSecs: -140, alightSecs: 500, frequencyOffsetSecs: 86400, frequencyInstance: false, inSeat: false };
  const point = { departureSecs: -200, arrivalSecs: 540, totalWalkSecs: 100, actualTransfers: 0,
    transitRounds: 1, serviceDate: 20261012, witnessLegs: 1, witness: [witness] };
  const selectors = goal === "portfolio" ? ARRIVE_BY_SELECTORS : [goal];
  return { scope: "deadline-winner-session-wasm-experiment", contract: "lexicographic-filter-winners-v1-no-arrival-floor",
    complete: true, completionScope: goal === "portfolio" ? "fixed-selectors-only" : "single-selector-only", queryKind: goal,
    requestedWindow: [...window], arrivalDeadline: 1000,
    winners: Object.fromEntries(selectors.map((s) => [s, empty ? null : point])),
    journeyContract: "complete-selected-movement-v1",
    journeys: empty ? [] : [{ point, access: { stopId: "A", walkSecs: 60 }, connections: [],
      rides: [{ witness, routeId: "R", routeShortName: "1", routeColor: null, tripId: "T", routeType: 3, mode: "BUS",
        fromStopId: "A", toStopId: "X", patternStopIds: ["A", "X"], approximate: false }],
      egress: { fromStopId: "X", exitStopId: "X", physicalWalkSecs: 0, callerWalkSecs: 40 } }],
    journeyByPreference: Object.fromEntries(selectors.map((s) => [s, empty ? null : 0])) };
}
class FakeProbe {
  static constructed = 0;
  static empty = false;
  static laterStageResourceFault = false;
  private window: readonly [number, number] = [-300, 1001];
  constructor() { FakeProbe.constructed++; }
  prepare(_query: unknown, options: unknown): void {
    const o = options as { windowStart: number; windowEnd: number }; this.window = [o.windowStart, o.windowEnd];
  }
  run_winner_journeys(goal: string): unknown {
    if (goal !== "latest-departure" && FakeProbe.laterStageResourceFault) {
      throw Object.assign(new Error("budget"), { ptnResourceLimit: "lookup-work" });
    }
    return output(goal, FakeProbe.empty, this.window);
  }
  latestDeparture(): unknown {
    return { schema: "latest-scan-v1", window: [-300, 1001], arrivalDeadline: 1000, departure: FakeProbe.empty ? null : -200,
      outOfScope: null, indexBuilt: true, scanIndexBytes: 2048 };
  }
  selectorDeparture(goal: string): unknown {
    return { schema: "selector-scan-v1", goal, window: [-300, 1001], arrivalDeadline: 1000,
      optimum: FakeProbe.empty ? null : goal === "fewest-transfers" ? 0 : 100, departure: FakeProbe.empty ? null : -200,
      outOfScope: null, indexBuilt: true, scanIndexBytes: 2048 };
  }
  free(): void {}
  static withImmutableBinding(): FakeProbe { return new FakeProbe(); }
}
class FakePtRouter {
  static transfersFault: Error | null = null;
  plan(): unknown { return ["normal"]; }
  resolveTime(): unknown { return null; }
  setTransfers(): void {
    const fault = FakePtRouter.transfersFault;
    FakePtRouter.transfersFault = null;
    if (fault) throw fault;
  }
}
const ptWasm = { PtRouter: FakePtRouter, default: async () => {} } as unknown as PtWasmModule;
function ownerHost(gate?: Promise<void>) {
  const feature = createArriveByFeature(async () => {
    await gate;
    return { default: async () => {}, TemporalDeadlineProbe: FakeProbe as never };
  });
  return createArriveByOwnerHost(feature);
}
const INIT = { id: 0, op: "init" as const, bytes: new Uint8Array([7]).buffer, mode: "covering-merge", city: "vilnius" };
/** The selected four-stage sequence (H81): latest first, then fastest,
 * fewest transfers and least walking. */
const LATER = ["fastest", "fewest-transfers", "least-walking"] as const;
function body(goal: ArriveByOwnerRequest["goal"] = "latest-departure"): Omit<ArriveByOwnerRequest, "generation"> {
  return { scope: SCOPE, goal, latestStage: goal === "fastest" ? "full-window" : "reverse-scan",
    prefixPolicy: "timetable-prepared", walkingTransferBounds: goal !== "latest-departure",
    // H86: the fastest stage carries the latest option's duration (900 - -200).
    durationBound: goal === "fastest" ? 1100 : null, mobilityProfile: "default", excludedModes: [], walkSpeedMps: 1.25, minTransferSecs: 120 };
}

beforeEach(() => { FakeProbe.constructed = 0; FakeProbe.empty = false; FakeProbe.laterStageResourceFault = false; FakePtRouter.transfersFault = null; });

describe("arriveByWarm in the owner worker host", () => {
  it("runs at the generation current when it runs", async () => {
    const handle = ownerHost();
    await handle(INIT);
    await handle({ id: 1, op: "setArriveByEnabled", enabled: true });
    const reply = await handle({ id: 2, op: "arriveByWarm", request: body() });
    expect(reply).toMatchObject({ ok: true, value: { dropped: false, request: { generation: 2 },
      outcome: { ok: true, latestScan: { outcome: "narrowed" }, state: { constructions: 1 } } } });
  });

  it.each(["arriveByCancelWarm", "arriveBy"] as const)("is dropped when a request (%s) waits behind it", async (op) => {
    let release!: () => void;
    const handle = ownerHost(new Promise<void>((r) => { release = r; }));
    await handle(INIT);
    const behind: ArriveByOwnerWorkerRequest = op === "arriveBy"
      ? { id: 3, op, request: { ...body(), generation: 2 } } : { id: 3, op };
    const replies = [handle({ id: 1, op: "setArriveByEnabled", enabled: true }),
      handle({ id: 2, op: "arriveByWarm", request: body() }), handle(behind)];
    release();
    const [enabled, warm, after] = await Promise.all(replies);
    expect(enabled).toMatchObject({ ok: true, value: { enabled: true } });
    expect(warm).toMatchObject({ ok: true, value: { dropped: true } });
    expect(after).toMatchObject({ ok: true });
    expect(FakeProbe.constructed).toBe(op === "arriveBy" ? 1 : 0);
  });

  it("is refused before the owner is attached", async () => {
    expect(await ownerHost()({ id: 1, op: "arriveByWarm", request: body() }))
      .toStrictEqual({ id: 1, ok: false, error: "arrive-by owner is not attached" });
  });
});

// --- the channel over a scripted worker ---------------------------------------
function ownerState(generation: number, enabled = true) {
  return { city: "vilnius", generation, enabled, transfersReady: true, poisoned: false, ownerLive: true,
    retainedInputBytes: 0, sourceCopyMs: 0, constructions: 1, retirements: 0, retirementMs: 0 };
}
function option(departureSecs: number, selectors: string[]) {
  return { journey: { point: { departureSecs, arrivalSecs: 900, actualTransfers: 0, totalWalkSecs: 100,
    transitRounds: 1, serviceDate: 20261012, witnessLegs: 0, witness: [] } }, selectors };
}
function outcome(request: ArriveByOwnerRequest, options: unknown[]) {
  return { ok: true, options, state: ownerState(request.generation), marks: { start: 1, end: 2 },
    latestScan: request.latestStage === "reverse-scan" ? { outcome: "narrowed", departure: -200 } : null };
}
const LATEST_OPTIONS = [option(-200, ["latest-departure"])];
/** One winner per stage; latest and fastest share a journey, as do the other two. */
const STAGE_OPTIONS: Record<string, unknown[]> = {
  "latest-departure": LATEST_OPTIONS, fastest: [option(-200, ["fastest"])],
  "fewest-transfers": [option(-250, ["fewest-transfers"])], "least-walking": [option(-250, ["least-walking"])],
};
/** The merged result, in the portfolio's selector order. */
const ALL_OPTIONS = [option(-200, ["latest-departure", "fastest"]), option(-250, ["least-walking", "fewest-transfers"])];
type Handler = (req: ArriveByWireRequest) => unknown;
function scripted(overrides: Partial<Record<ArriveByWireRequest["op"], Handler>> = {}) {
  const generation = { value: 2 };
  const handlers: Record<ArriveByWireRequest["op"], Handler> = {
    setArriveByEnabled: () => ownerState(generation.value),
    arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return outcome(r, STAGE_OPTIONS[r.goal]!);
    },
    arriveByWarm: (req) => {
      const request = { ...(req as { request: ArriveByOwnerRequest }).request, generation: generation.value };
      return { dropped: false, request, outcome: outcome(request, LATEST_OPTIONS) };
    },
    arriveByCancelWarm: () => undefined,
    ...overrides,
  };
  const calls: ArriveByWireRequest[] = [];
  const call = async (req: ArriveByWireRequest): Promise<unknown> => { calls.push(structuredClone(req)); return handlers[req.op](req); };
  const channel = createArriveByChannel(call);
  const goals = () => calls.filter((c) => c.op === "arriveBy").map((c) => (c as { request: ArriveByOwnerRequest }).request.goal);
  return { channel, calls, goals, generation };
}
function deferred<T = unknown>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function record(channel: ReturnType<typeof createArriveByChannel>, input = INPUT) {
  const updates: ArriveBySearchState[] = [];
  const search = channel.search(input, (s) => updates.push(s));
  return { search, updates, statuses: () => updates.map((u) => u.status) };
}

describe("arrive-by channel", () => {
  it("runs the latest by the reverse scan, then fastest, fewest transfers and least walking, at the reported generation", async () => {
    const s = scripted();
    const r = record(s.channel);
    const final = await r.search.done;
    expect(r.statuses()).toEqual(["pending", "latest", "complete"]);
    expect(r.updates[1]!.options).toEqual(LATEST_OPTIONS);
    expect(final.options).toEqual(ALL_OPTIONS);
    expect(final).toMatchObject({ latestSource: "request", failure: null, latestScan: { outcome: "narrowed" },
      selectorScans: { "fewest-transfers": { outcome: "narrowed" }, "least-walking": { outcome: "narrowed" } } });
    expect(final.marks.latest! <= final.marks.complete!).toBe(true);
    expect(Object.keys(final.ownerMarks)).toEqual(["latest-departure", ...LATER]);
    expect(Object.values(final.ownerMarks).every((m) => m !== null)).toBe(true);
    expect(s.calls.map((c) => c.op)).toEqual(["setArriveByEnabled", "arriveBy", "arriveBy", "arriveBy", "arriveBy"]);
    const requests = s.calls.slice(1).map((c) => (c as { request: ArriveByOwnerRequest }).request);
    expect(requests).toEqual((["latest-departure", ...LATER] as const).map((g) => ({ generation: 2, ...body(g) })));
    expect(s.channel.state()).toMatchObject({ generation: 2, enabled: true });
  });

  it("bounds the fastest stage by the certified latest option's duration (H86)", async () => {
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return outcome(r, r.goal === "latest-departure"
        ? [{ journey: { point: { ...option(-150, []).journey.point, arrivalSecs: 750 } }, selectors: ["latest-departure"] }]
        : [option(-200, [r.goal])]);
    } });
    await s.channel.search(INPUT).done;
    const requests = s.calls.filter((c) => c.op === "arriveBy").map((c) => (c as { request: ArriveByOwnerRequest }).request);
    expect(requests.map((r) => [r.goal, r.durationBound])).toEqual([
      ["latest-departure", null], ["fastest", 900], ["fewest-transfers", null], ["least-walking", null]]);
  });

  it("warms the latest stage without a bound", async () => {
    const s = scripted();
    expect(await s.channel.warm(INPUT)).toBe("ran");
    const warm = s.calls.find((c) => c.op === "arriveByWarm") as { request: Omit<ArriveByOwnerRequest, "generation"> };
    expect(warm.request.durationBound).toBeNull();
  });

  it("merges stages that share a winner, in the portfolio's selector order", async () => {
    const shared = option(-200, []);
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return outcome(r, [{ ...shared, selectors: [r.goal] }]);
    } });
    const final = await s.channel.search(INPUT).done;
    expect(final).toMatchObject({ status: "complete" });
    expect(final.options.map((o) => o.selectors)).toEqual([ARRIVE_BY_SELECTORS]);
  });

  it("concurrent callers share one enable", async () => {
    const gate = deferred();
    const s = scripted({ setArriveByEnabled: async () => { await gate.promise; return ownerState(2); } });
    const warms = [s.channel.warm(INPUT), s.channel.warm(OTHER)];
    gate.resolve(undefined);
    expect(await Promise.all(warms)).toEqual(["ran", "ran"]);
    await s.channel.search(INPUT).done;
    expect(s.calls.filter((c) => c.op === "setArriveByEnabled")).toHaveLength(1);
  });

  it("a latest stage with no option completes without the later stages", async () => {
    const s = scripted({ arriveBy: (req) => outcome((req as { request: ArriveByOwnerRequest }).request, []) });
    const r = record(s.channel);
    expect(await r.search.done).toMatchObject({ status: "complete", options: [] });
    expect(r.statuses()).toEqual(["pending", "complete"]);
    expect(s.goals()).toEqual(["latest-departure"]);
  });

  it("a latest failure fails the search and posts no later stage", async () => {
    const failure = { stage: "search", code: "WinnerJourneyFailed", message: "Lookup(WorkExhausted)" };
    const s = scripted({ arriveBy: (req) => ({ ...outcome((req as { request: ArriveByOwnerRequest }).request, []), ok: false, failure }) });
    expect(await s.channel.search(INPUT).done).toMatchObject({ status: "failed", options: [], failure });
    expect(s.goals()).toEqual(["latest-departure"]);
  });

  it.each(LATER)("a %s failure clears the latest option and posts no further stage", async (goal) => {
    const failure = { stage: "search", code: "WinnerJourneyFailed", message: "cap" };
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return r.goal === goal ? { ...outcome(r, []), ok: false, failure } : outcome(r, STAGE_OPTIONS[r.goal]!);
    } });
    const r = record(s.channel);
    expect(await r.search.done).toMatchObject({ status: "failed", options: [], failure });
    expect(r.statuses()).toEqual(["pending", "latest", "failed"]);
    expect(s.goals()).toEqual(["latest-departure", ...LATER.slice(0, LATER.indexOf(goal) + 1)]);
  });

  it.each(LATER.flatMap((goal) => (["prepare", "search"] as const).map((stage) => [goal, stage] as const)))(
    "after a %s structured %s limit, retains only the certified latest (H62), not completed later stages", async (goal, stage) => {
    const failure = { stage, code: "ResourceLimit", resourceLimit: "lookup-work", message: "budget" };
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return r.goal === goal ? { ...outcome(r, []), ok: false, failure } : outcome(r, STAGE_OPTIONS[r.goal]!);
    } });
    const r = record(s.channel);
    expect(await r.search.done).toMatchObject({ status: "limited", options: LATEST_OPTIONS, failure });
    expect(r.statuses()).toEqual(["pending", "latest", "limited"]);
    expect(r.updates.at(-1)!.marks.complete).toBeUndefined();
    expect(s.goals()).toEqual(["latest-departure", ...LATER.slice(0, LATER.indexOf(goal) + 1)]);
    s.channel.observeTransfers({ ...ownerState(3), transfersReady: false });
    expect(r.updates.at(-1)).toMatchObject({ status: "failed", options: [], failure: { code: "InputChanged" } });
  });

  it.each([
    { stage: "contract", code: "ResourceLimit", resourceLimit: "lookup-work" },
    { stage: "search", code: "ResourceLimit", resourceLimit: "unknown-limit" },
    { stage: "search", code: "WinnerJourneyFailed", resourceLimit: "lookup-work" },
    { stage: "transport", code: "WorkerUnavailable" },
  ])("clears on untrusted failure classification: %j", async (reason) => {
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return r.goal === "fastest" ? { ...outcome(r, []), ok: false, failure: { ...reason, message: "fault" } } : outcome(r, LATEST_OPTIONS);
    } });
    expect(await s.channel.search(INPUT).done).toMatchObject({ status: "failed", options: [] });
  });

  it("a resource failure in latest has no certified result to retain", async () => {
    const s = scripted({ arriveBy: (req) => ({ ...outcome((req as { request: ArriveByOwnerRequest }).request, []),
      ok: false, failure: { stage: "search", code: "ResourceLimit", resourceLimit: "segments", message: "cap" } }) });
    expect(await s.channel.search(INPUT).done).toMatchObject({ status: "failed", options: [] });
    expect(s.goals()).toEqual(["latest-departure"]);
  });

  it("invalidates latest while a later stage is in flight and ignores its late failure", async () => {
    const later = deferred();
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return r.goal === "fewest-transfers" ? later.promise : outcome(r, STAGE_OPTIONS[r.goal]!);
    } });
    const r = record(s.channel);
    await vi.waitFor(() => expect(s.goals()).toEqual(["latest-departure", "fastest", "fewest-transfers"]));
    s.channel.observeTransfers({ ...ownerState(3), transfersReady: false });
    later.resolve({ ...outcome({ generation: 2, ...body("fewest-transfers") }, []), ok: false,
      failure: { stage: "search", code: "ResourceLimit", resourceLimit: "lookup-work", message: "cap" } });
    expect(await r.search.done).toMatchObject({ status: "failed", options: [], failure: { code: "InputChanged" } });
    expect(s.channel.state()?.generation).toBe(3);
    expect(s.goals()).toEqual(["latest-departure", "fastest", "fewest-transfers"]);
  });

  it("keeps every stage bound to copied rider settings", async () => {
    const latest = deferred();
    const input = structuredClone(INPUT);
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return r.goal === "latest-departure" ? latest.promise : outcome(r, STAGE_OPTIONS[r.goal]!);
    } });
    const r = record(s.channel, input);
    await vi.waitFor(() => expect(s.goals()).toEqual(["latest-departure"]));
    Object.assign(input, { walkSpeedMps: 0.6, minTransferSecs: 300 });
    (input.excludedModes as number[]).push(3);
    latest.resolve(outcome({ generation: 2, ...body() }, LATEST_OPTIONS));
    expect(await r.search.done).toMatchObject({ status: "complete" });
    expect(s.goals()).toEqual(["latest-departure", ...LATER]);
    for (const call of s.calls.filter((c) => c.op === "arriveBy") as { request: ArriveByOwnerRequest }[]) {
      expect(call.request).toMatchObject({ walkSpeedMps: 1.25, minTransferSecs: 120, excludedModes: [] });
    }
  });

  it("an explicit cancel clears a terminal limited result", async () => {
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return r.goal === "least-walking" ? { ...outcome(r, []), ok: false,
        failure: { stage: "search", code: "ResourceLimit", resourceLimit: "segments", message: "cap" } } : outcome(r, STAGE_OPTIONS[r.goal]!);
    } });
    const r = record(s.channel);
    expect(await r.search.done).toMatchObject({ status: "limited" });
    r.search.cancel(); expect(r.updates.at(-1)).toMatchObject({ status: "cancelled", options: [] });
  });

  it("revokes retained results immediately, without awaiting a blocked worker update", async () => {
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return r.goal === "least-walking" ? { ...outcome(r, []), ok: false,
        failure: { stage: "search", code: "ResourceLimit", resourceLimit: "segments", message: "cap" } } : outcome(r, STAGE_OPTIONS[r.goal]!);
    } });
    const r = record(s.channel); await r.search.done;
    s.channel.invalidateInputs();
    expect(r.updates.at(-1)).toMatchObject({ status: "failed", options: [], failure: { code: "InputChanged" } });
    expect(s.channel.state()?.generation).toBe(2);
  });

  it("does not cache a warm-up that finishes after immediate input invalidation", async () => {
    const reply = deferred();
    const s = scripted({ arriveByWarm: () => reply.promise });
    const warm = s.channel.warm(INPUT);
    await Promise.resolve();
    s.channel.invalidateInputs();
    const request = { generation: 2, ...body() };
    reply.resolve({ dropped: false, request, outcome: outcome(request, LATEST_OPTIONS) });
    expect(await warm).toBe("dropped");
    expect(await s.channel.search(INPUT).done).toMatchObject({ status: "complete", latestSource: "request" });
  });

  it.each([
    ["a later winner departing after the latest", { fastest: [option(-190, ["fastest"])] }],
    ["a shared winner with different movement", { fastest: [{ ...option(-200, ["fastest"]), journey: { ...option(-200, []).journey, rides: [] } }] }],
    ["a later stage without a winner", { "least-walking": [] }],
    ["a later stage with another selector's winner", { "fewest-transfers": [option(-250, ["least-walking"])] }],
  ] as [string, Record<string, unknown[]>][])("%s fails as SelectorsDisagree", async (_name, replace) => {
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return outcome(r, replace[r.goal] ?? STAGE_OPTIONS[r.goal]!);
    } });
    expect(await s.channel.search(INPUT).done)
      .toMatchObject({ status: "failed", options: [], failure: { stage: "contract", code: "SelectorsDisagree" } });
  });

  it("cancelled during a later stage, a search delivers nothing more and posts no further stage", async () => {
    const fastest = deferred();
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return r.goal === "fastest" ? fastest.promise : outcome(r, STAGE_OPTIONS[r.goal]!);
    } });
    const r = record(s.channel);
    await vi.waitFor(() => expect(s.goals()).toEqual(["latest-departure", "fastest"]));
    r.search.cancel();
    fastest.resolve(outcome({ generation: 2, ...body("fastest") }, STAGE_OPTIONS.fastest!));
    expect(await r.search.done).toMatchObject({ status: "cancelled", options: [] });
    expect(r.statuses()).toEqual(["pending", "latest", "cancelled"]);
    expect(s.goals()).toEqual(["latest-departure", "fastest"]);
  });

  it("cancelled before its latest result, a search delivers nothing more and posts no later stage", async () => {
    const latest = deferred();
    const s = scripted({ arriveBy: () => latest.promise });
    const r = record(s.channel);
    await vi.waitFor(() => expect(s.goals()).toEqual(["latest-departure"]));
    r.search.cancel();
    latest.resolve(outcome({ generation: 2, ...body() }, LATEST_OPTIONS));
    expect(await r.search.done).toMatchObject({ status: "cancelled", options: [] });
    expect(r.statuses()).toEqual(["pending", "cancelled"]);
    expect(s.goals()).toEqual(["latest-departure"]);
  });

  it("cancelled on its latest update, a search posts no later stage", async () => {
    const s = scripted();
    const updates: string[] = [];
    const search = s.channel.search(INPUT, (u) => { updates.push(u.status); if (u.status === "latest") search.cancel(); });
    expect(await search.done).toMatchObject({ status: "cancelled" });
    expect(updates).toEqual(["pending", "latest", "cancelled"]);
    expect(s.goals()).toEqual(["latest-departure"]);
  });

  it("a new search cancels the previous one", async () => {
    const first = deferred();
    let n = 0;
    const s = scripted({ arriveBy: (req) => {
      const r = (req as { request: ArriveByOwnerRequest }).request;
      return n++ === 0 ? first.promise : outcome(r, STAGE_OPTIONS[r.goal]!);
    } });
    const a = record(s.channel);
    await vi.waitFor(() => expect(s.goals()).toEqual(["latest-departure"]));
    const b = record(s.channel, OTHER);
    expect(a.statuses()).toEqual(["pending", "cancelled"]);
    first.resolve(outcome({ generation: 2, ...body() }, LATEST_OPTIONS));
    expect(await b.search.done).toMatchObject({ status: "complete" });
    expect(await a.search.done).toMatchObject({ status: "cancelled" });
    expect(a.statuses()).toEqual(["pending", "cancelled"]);
    expect(s.goals()).toEqual(["latest-departure", "latest-departure", ...LATER]);
  });

  it("reuses a warm-up result once, for the identical request", async () => {
    const s = scripted();
    expect(await s.channel.warm(INPUT)).toBe("ran");
    expect(await s.channel.warm(INPUT)).toBe("skipped");
    const first = await s.channel.search(INPUT).done;
    expect(first).toMatchObject({ status: "complete", latestSource: "warm-up" });
    expect(s.goals()).toEqual([...LATER]);
    expect(await s.channel.search(INPUT).done).toMatchObject({ latestSource: "request" });
    expect(s.goals()).toEqual([...LATER, "latest-departure", ...LATER]);
  });

  it.each([
    { walkSpeedMps: 0.9 },
    { minTransferSecs: 300 },
  ])("does not reuse a warm-up after rider settings change: %j", async (settings) => {
    const s = scripted();
    expect(await s.channel.warm(INPUT)).toBe("ran");
    expect(await s.channel.search({ ...INPUT, ...settings }).done).toMatchObject({
      status: "complete", latestSource: "request",
    });
    expect(s.goals()).toEqual(["latest-departure", ...LATER]);
    const calls = s.calls.filter((c) => c.op === "arriveBy") as { request: ArriveByOwnerRequest }[];
    for (const call of calls) expect(call.request).toMatchObject(settings);
  });

  it("waits for an identical warm-up in flight instead of posting a second request", async () => {
    const warm = deferred();
    const s = scripted({ arriveByWarm: () => warm.promise });
    const result = s.channel.warm(INPUT);
    const search = s.channel.search(INPUT);
    await Promise.resolve(); await Promise.resolve();
    expect(s.goals()).toEqual([]);
    const request = { ...body(), generation: 2 };
    warm.resolve({ dropped: false, request, outcome: outcome(request, LATEST_OPTIONS) });
    expect(await result).toBe("ran");
    expect(await search.done).toMatchObject({ status: "complete", latestSource: "warm-up" });
    expect(s.goals()).toEqual([...LATER]);
  });

  it("does not reuse a warm-up after the generation moves, nor a different request", async () => {
    const s = scripted();
    await s.channel.warm(INPUT);
    s.generation.value = 3;
    s.channel.observeTransfers(ownerState(3));
    expect(await s.channel.search(INPUT).done).toMatchObject({ latestSource: "request" });
    const latest = (s.calls.find((c) => c.op === "arriveBy") as { request: ArriveByOwnerRequest }).request;
    expect(latest.generation).toBe(3);
    // The old generation's result no longer counts as warm.
    expect(await s.channel.warm(INPUT)).toBe("ran");
    expect(await s.channel.search(OTHER).done).toMatchObject({ latestSource: "request" });
  });

  it("a search for another query cancels a warm-up still in flight; an identical search does not", async () => {
    const warm = deferred();
    const s = scripted({ arriveByWarm: () => warm.promise });
    const result = s.channel.warm(INPUT);
    const same = s.channel.search(INPUT);
    expect(s.calls.some((c) => c.op === "arriveByCancelWarm")).toBe(false);
    same.cancel();
    const other = s.channel.search(OTHER);
    expect(s.calls.filter((c) => c.op === "arriveByCancelWarm")).toHaveLength(1);
    warm.resolve({ dropped: true });
    expect(await result).toBe("dropped");
    expect(await other.done).toMatchObject({ status: "complete", latestSource: "request" });
    // Nothing is in flight now, so the next search posts no cancellation.
    await s.channel.search(INPUT).done;
    expect(s.calls.filter((c) => c.op === "arriveByCancelWarm")).toHaveLength(1);
  });

  it("reports a warm-up that built the owner but yielded its query", async () => {
    const s = scripted({ arriveByWarm: () => ({ dropped: true, constructed: true }) });
    expect(await s.channel.warm(INPUT)).toBe("constructed");
    expect(await s.channel.search(INPUT).done).toMatchObject({ status: "complete", latestSource: "request" });
  });

  it("a dropped warm-up leaves the search to post its own; a warm-up during a search is skipped", async () => {
    const s = scripted({ arriveByWarm: () => ({ dropped: true }) });
    expect(await s.channel.warm(INPUT)).toBe("dropped");
    const search = s.channel.search(INPUT);
    expect(await s.channel.warm(OTHER)).toBe("skipped");
    expect(await search.done).toMatchObject({ status: "complete", latestSource: "request" });
    expect(s.goals()).toEqual(["latest-departure", ...LATER]);
  });

  it("types transport and runtime failures", async () => {
    const s = scripted({ arriveBy: () => { throw new Error("worker gone"); } });
    expect(await s.channel.search(INPUT).done)
      .toMatchObject({ status: "failed", failure: { stage: "transport", code: "WorkerUnavailable", message: "worker gone" } });
    const t = scripted({ setArriveByEnabled: () => { throw new Error("offline"); } });
    expect(await t.channel.search(INPUT).done)
      .toMatchObject({ status: "failed", failure: { stage: "availability", code: "RuntimeUnavailable", message: "offline" } });
    expect(await t.channel.warm(INPUT)).toBe("ran");
  });

  it("arriveByScope opens the window four hours before the deadline, in that instant's frame", () => {
    const entry = [{ stopId: "A", walkSecs: 60 }], exit = [{ stopId: "X", walkSecs: 40 }];
    const scope = arriveByScope({ serviceDate: "20261012", timeOriginUnix: 0, departureSecs: 75_600 }, entry, exit);
    expect(scope).toEqual({ serviceDate: 20261012, windowStart: 75_600, windowEnd: 90_001, arrivalDeadline: 90_000,
      maxRounds: 4, entryStops: entry, exitStops: exit });
    expect(scope.entryStops[0]).not.toBe(entry[0]);
  });
});

// --- the router handle in an opt-in build -------------------------------------
class FakeRouterWorker {
  onmessage: ((event: MessageEvent<PtRouterReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly received: PtRouterRequest[] = [];
  terminated = false;
  private readonly handle = createPtRouterHost(async () => ptWasm);
  postMessage(message: PtRouterRequest, transfer: Transferable[] = []): void {
    const received = structuredClone(message, { transfer });
    this.received.push(received);
    void this.handle(received).then((reply) => this.onmessage?.({ data: structuredClone(reply) } as MessageEvent<PtRouterReply>));
  }
  terminate(): void { this.terminated = true; }
}
class FakeOwnerWorker {
  static gate: Promise<void> | undefined;
  onmessage: ((event: MessageEvent<ArriveByOwnerWorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly received: ArriveByOwnerWorkerRequest[] = [];
  terminated = false;
  private readonly handle = ownerHost(FakeOwnerWorker.gate);
  postMessage(message: ArriveByOwnerWorkerRequest, transfer: Transferable[] = []): void {
    if (this.terminated) return;
    const received = structuredClone(message, { transfer });
    this.received.push(received);
    void this.handle(received).then((reply) => {
      if (!this.terminated) this.onmessage?.({ data: structuredClone(reply) } as MessageEvent<ArriveByOwnerWorkerReply>);
    });
  }
  terminate(): void { this.terminated = true; }
  die(): void { this.onerror?.({ message: "owner worker crashed", preventDefault() {} } as ErrorEvent); }
}

describe("buildPtRouter in an opt-in build", () => {
  let routers: FakeRouterWorker[] = [];
  let owners: FakeOwnerWorker[] = [];
  const query = { entryStops: [], exitStops: [], date: "20261012", departureSecs: 0 };
  beforeEach(() => {
    routers = []; owners = []; FakeOwnerWorker.gate = undefined;
    hoisted.makeRouterWorker = () => { const w = new FakeRouterWorker(); routers.push(w); return w; };
    hoisted.makeOwnerWorker = () => { const w = new FakeOwnerWorker(); owners.push(w); return w; };
    vi.stubGlobal("Worker", FakeRouterWorker);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("runs the owner in its own worker; transfers reach it only after the router accepted them", async () => {
    const router = await buildPtRouter(new Uint8Array([1, 2, 3]), "vilnius");
    const channel = router.arriveBy!;
    expect(channel.state()).toBeNull();
    await router.setTransfers(new Uint8Array([4, 5]));
    expect(channel.state()).toMatchObject({ generation: 2, enabled: false, transfersReady: true, retainedInputBytes: 5 });
    const final = await channel.search(INPUT).done;
    expect(final).toMatchObject({ status: "complete", latestSource: "request", latestScan: { outcome: "narrowed", departure: -200 } });
    expect(final.options.map((o) => o.selectors)).toEqual([ARRIVE_BY_SELECTORS]);
    expect(channel.state()).toMatchObject({ generation: 3, enabled: true, constructions: 1 });
    expect(routers.map((w) => w.received.map((r) => r.op))).toEqual([["init", "setTransfers"]]);
    expect(Object.hasOwn(routers[0]!.received[0]!, "city")).toBe(false);
    expect(owners.map((w) => w.received.map((r) => r.op)))
      .toEqual([["init", "invalidateTransfers", "replaceTransfers", "setArriveByEnabled", "arriveBy", "arriveBy", "arriveBy", "arriveBy"]]);
    expect(owners[0]!.received[0]).toMatchObject({ op: "init", mode: "covering-merge", city: "vilnius" });
    expect(await router.plan(query)).toEqual(["normal"]);
  });

  it("a failed router transfer update never hands the owner the new transfers", async () => {
    const router = await buildPtRouter(new Uint8Array([1]), "vilnius");
    FakePtRouter.transfersFault = new Error("bad PTFT");
    await expect(router.setTransfers(new Uint8Array([9]))).rejects.toThrow("bad PTFT");
    expect(await router.arriveBy!.search(INPUT).done)
      .toMatchObject({ status: "failed", failure: { stage: "availability", code: "TransfersUnavailable" } });
    expect(owners[0]!.received.map((r) => r.op)).toEqual(["init", "invalidateTransfers", "setArriveByEnabled", "arriveBy"]);
    await router.setTransfers(new Uint8Array([9]));
    expect(await router.arriveBy!.search(INPUT).done).toMatchObject({ status: "complete" });
  });

  it("a plan does not wait for the owner worker (H74)", async () => {
    let release!: () => void;
    FakeOwnerWorker.gate = new Promise<void>((r) => { release = r; });
    const router = await buildPtRouter(new Uint8Array([1]), "vilnius");
    // The owner's first enable is stuck loading its runtime.
    const search = router.arriveBy!.search(INPUT).done;
    expect(await router.plan(query)).toEqual(["normal"]);
    expect(await router.resolveTime(0)).toBeNull();
    release();
    expect(await search).toMatchObject({ status: "complete" });
  });

  it("a warm-up answers the identical search; a different search drops a warm-up that has not started", async () => {
    const router = await buildPtRouter(new Uint8Array([1]), "vilnius");
    expect(await router.arriveBy!.warm(INPUT)).toBe("ran");
    expect(await router.arriveBy!.search(INPUT).done).toMatchObject({ status: "complete", latestSource: "warm-up" });
    expect(FakeProbe.constructed).toBe(1);

    let release!: () => void;
    FakeOwnerWorker.gate = new Promise<void>((r) => { release = r; });
    const fresh = await buildPtRouter(new Uint8Array([1]), "vilnius");
    const warm = fresh.arriveBy!.warm(INPUT);
    // Another query the fake probe still answers (it ignores the profile).
    const search = fresh.arriveBy!.search({ ...INPUT, mobilityProfile: "wheelchair" }).done;
    release();
    expect(await warm).toBe("dropped");
    expect(await search).toMatchObject({ status: "complete", latestSource: "request" });
    expect(owners[1]!.received.map((r) => r.op)).toEqual(["init", "setArriveByEnabled", "arriveByWarm", "arriveByCancelWarm",
      "arriveBy", "arriveBy", "arriveBy", "arriveBy"]);
    expect(FakeProbe.constructed).toBe(2);
  });

  it("an owner worker that dies fails arrive-by typed and leaves the router alive", async () => {
    const router = await buildPtRouter(new Uint8Array([1]), "vilnius");
    owners[0]!.die();
    expect(await router.arriveBy!.search(INPUT).done)
      .toMatchObject({ status: "failed", failure: { stage: "availability", code: "RuntimeUnavailable", message: "owner worker crashed" } });
    expect(owners[0]!.terminated).toBe(true);
    expect(router.isAlive()).toBe(true);
    expect(await router.plan(query)).toEqual(["normal"]);
    await router.setTransfers(new Uint8Array([2]));
  });

  it.each(["transfer-update", "worker-crash", "free"] as const)("revokes a retained worker result immediately on %s", async (change) => {
    FakeProbe.laterStageResourceFault = true;
    const router = await buildPtRouter(new Uint8Array([1]), "vilnius");
    await router.setTransfers(new Uint8Array([4, 5]));
    const updates: ArriveBySearchState[] = [];
    expect(await router.arriveBy!.search(INPUT, (s) => updates.push(s)).done)
      .toMatchObject({ status: "limited", failure: { code: "ResourceLimit", resourceLimit: "lookup-work" } });
    let pending: Promise<void> | undefined;
    if (change === "transfer-update") pending = router.setTransfers(new Uint8Array([6]));
    if (change === "worker-crash") owners[0]!.die();
    if (change === "free") router.free();
    expect(updates.at(-1)).toMatchObject({ status: "failed", options: [], failure: { code: "InputChanged" } });
    await pending;
  });

  it("free stops both workers; without a city there is no owner worker", async () => {
    const router = await buildPtRouter(new Uint8Array([1]), "vilnius");
    router.free();
    expect(routers[0]!.terminated).toBe(true);
    // The owner's init is still answering; it stops once that reply arrives.
    await vi.waitFor(() => expect(owners[0]!.terminated).toBe(true));
    const plain = await buildPtRouter(new Uint8Array([1]));
    expect(plain.arriveBy).toBeUndefined();
    expect(owners).toHaveLength(1);
  });
});
