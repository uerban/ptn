import { describe, expect, it, vi } from "vitest";
import { createArriveByOwnerHost } from "./ptArriveByOwnerHost.ts";
import { ArriveByWorkerOwner, type ArriveByOwnerMarks, type ArriveByOwnerRequest } from "./temporalArriveByOwner.ts";
import { ARRIVE_BY_RESOURCE_LIMITS, ARRIVE_BY_SELECTORS } from "./temporalArriveByResults.ts";

function request(generation = 2): ArriveByOwnerRequest {
  return { generation, goal: "portfolio", latestStage: "full-window", prefixPolicy: "duration-rebuild", walkingTransferBounds: false,
    durationBound: null, mobilityProfile: "default", excludedModes: [], walkSpeedMps: 1.25, minTransferSecs: 120,
    scope: { serviceDate: 20261012, windowStart: -300, windowEnd: 1001, arrivalDeadline: 1000, maxRounds: 4,
      entryStops: [{ stopId: "A", walkSecs: 60 }], exitStops: [{ stopId: "X", walkSecs: 40 }] } };
}
function output(goal: string = "portfolio", empty = false, window: readonly [number, number] = [-300, 1001], deadline = 1000) {
  const witness = { serviceDate: 20261011, routeIdx: 1, readerRouteIdx: 2, tripIdx: 3, boardPosition: 0,
    alightPosition: 1, boardSecs: -140, alightSecs: 500, frequencyOffsetSecs: 86400, frequencyInstance: false, inSeat: false };
  const point = { departureSecs: -200, arrivalSecs: 540, totalWalkSecs: 100, actualTransfers: 0,
    transitRounds: 1, serviceDate: 20261012, witnessLegs: 1, witness: [witness] };
  const selectors = goal === "portfolio" ? ARRIVE_BY_SELECTORS : [goal];
  return { scope: "deadline-winner-session-wasm-experiment", contract: "lexicographic-filter-winners-v1-no-arrival-floor",
    complete: true, completionScope: goal === "portfolio" ? "fixed-selectors-only" : "single-selector-only", queryKind: goal,
    requestedWindow: [...window], arrivalDeadline: deadline,
    winners: Object.fromEntries(selectors.map((s) => [s, empty ? null : point])),
    journeyContract: "complete-selected-movement-v1",
    journeys: empty ? [] : [{ point, access: { stopId: "A", walkSecs: 60 }, connections: [],
      rides: [{ witness, routeId: "R", routeShortName: "1", routeColor: null, tripId: "T", routeType: 3, mode: "BUS",
        fromStopId: "A", toStopId: "X", patternStopIds: ["A", "X"], approximate: false }],
      egress: { fromStopId: "X", exitStopId: "X", physicalWalkSecs: 0, callerWalkSecs: 40 } }],
    journeyByPreference: Object.fromEntries(selectors.map((s) => [s, empty ? null : 0])) };
}
function scanWire(departure: number | null = -200, outOfScope: string | null = null) {
  return { schema: "latest-scan-v1", window: [-300, 1001], arrivalDeadline: 1000, departure, outOfScope,
    indexBuilt: true, dates: 2, instances: 9, templatePositions: 30, positionScans: 40, labelRelaxations: 12,
    scanIndexBytes: 2048, coreMs: 0.5 };
}
function selectorWire(goal: string, optimum: number | null = goal === "fewest-transfers" ? 0 : 100,
  departure: number | null = optimum === null ? null : -200, outOfScope: string | null = null) {
  return { schema: "selector-scan-v1", goal, window: [-300, 1001], arrivalDeadline: 1000, optimum, departure, outOfScope,
    indexBuilt: true, dates: 2, instances: 9, templatePositions: 30, positionScans: 40, labelRelaxations: 12,
    scanIndexBytes: 2048, coreMs: 0.5 };
}
function fixture(resettable = false) {
  // The fake selector echoes the window and deadline it was prepared on, as the probe does.
  let prepared: readonly [number, number] = [-300, 1001], deadline = 1000;
  const prepare = vi.fn((_query: unknown, options: unknown) => {
    const o = options as { windowStart: number; windowEnd: number; arrivalDeadline: number };
    prepared = [o.windowStart, o.windowEnd]; deadline = o.arrivalDeadline;
  });
  const run = vi.fn((goal: string) => output(goal, false, prepared, deadline)), free = vi.fn();
  const scan = vi.fn((_query: unknown, _start: number, _end: number, _deadline: number): unknown => scanWire());
  const selector = vi.fn((goal: string, _query: unknown, _start: number, _end: number, _deadline: number): unknown => selectorWire(goal));
  const clear = vi.fn();
  const factory = vi.fn((_ptb: Uint8Array, _ptft: Uint8Array, _mode: string) => ({ prepare, run_winner_journeys: run,
    latestDeparture: scan, selectorDeparture: selector, free, ...(resettable ? { clear } : {}) }));
  const bytes = new Uint8Array([1, 2, 3]), transfers = new Uint8Array([4, 5]);
  const owner = new ArriveByWorkerOwner(factory, bytes, "covering-merge", "vilnius");
  const enable = () => owner.setEnabled(true).generation;
  return { owner, factory, prepare, run, scan, selector, clear, free, bytes, transfers, enable };
}

describe("optional arrive-by worker owner", () => {
  it("constructs nothing until the first enabled request, then reuses one owner", () => {
    const f = fixture();
    expect(f.owner.snapshot()).toMatchObject({ enabled: false, generation: 1, ownerLive: false, retainedInputBytes: 3 });
    expect(f.owner.run(request(1))).toMatchObject({ ok: false, failure: { stage: "availability", code: "Disabled" } });
    expect(f.factory).not.toHaveBeenCalled();
    const generation = f.enable(); expect(f.factory).not.toHaveBeenCalled();
    const first = f.owner.run(request(generation)), second = f.owner.run(request(generation));
    expect(first).toMatchObject({ ok: true, state: { constructions: 1, ownerLive: true } });
    expect(second).toMatchObject({ ok: true, state: { constructions: 1 } });
    expect(f.factory).toHaveBeenCalledTimes(1); expect(f.prepare).toHaveBeenCalledTimes(2);
    if (!first.ok || !second.ok) throw new Error("unexpected failure");
    expect(first.options[0]!.selectors).toEqual(ARRIVE_BY_SELECTORS);
    expect(first.options[0]!.journey.point.departureSecs).toBe(-200);
    expect(first.options[0]!.journey.rides[0]!.witness.serviceDate).toBe(20261011);
    expect(first.marks.constructorCopyBytes).toBe(3); expect(second.marks.constructStart).toBeUndefined();
    for (const marks of [first.marks, second.marks]) {
      const values = [marks.start, marks.constructStart, marks.constructEnd, marks.prepareStart, marks.prepareEnd,
        marks.searchStart, marks.searchEnd, marks.decodeStart, marks.decodeEnd, marks.end].filter((x) => x !== undefined);
      expect(values).toEqual([...values].sort((a, b) => a - b));
      expect(Object.isFrozen(marks)).toBe(true);
    }
    expect(Object.isFrozen(first.state)).toBe(true);
  });

  it("disable retires exactly once; source memory remains counted and re-enable is lazy", () => {
    const f = fixture(), generation = f.enable(); f.owner.run(request(generation));
    expect(f.owner.setEnabled(false)).toMatchObject({ enabled: false, ownerLive: false, retainedInputBytes: 3, retirements: 1 });
    f.owner.setEnabled(false); expect(f.free).toHaveBeenCalledTimes(1);
    const next = f.enable(); expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.owner.run(request(generation))).toMatchObject({ ok: false, failure: { code: "StaleGeneration" } });
    expect(f.owner.run(request(next))).toMatchObject({ ok: true, state: { constructions: 2 } });
  });

  it("owns source snapshots and protects them from factory mutation", () => {
    const f = fixture();
    f.owner.invalidateTransfers(); f.owner.replaceTransfers(f.transfers);
    f.bytes.fill(9); f.transfers.fill(8);
    const generation = f.enable(); f.owner.run(request(generation));
    const first = f.factory.mock.calls[0]!;
    expect([...first[0]]).toEqual([1, 2, 3]); expect([...first[1]]).toEqual([4, 5]);
    first[0].fill(7); first[1].fill(6);
    f.owner.setEnabled(false); const next = f.enable(); f.owner.run(request(next));
    expect([...f.factory.mock.calls[1]![0]]).toEqual([1, 2, 3]);
    expect([...f.factory.mock.calls[1]![1]]).toEqual([4, 5]);
    expect(f.owner.snapshot().retainedInputBytes).toBe(5);
  });

  it("invalidates before replacing transfers, rejects stale generations, and supports empty PTFT", () => {
    const f = fixture(); f.owner.run(request(f.enable())); const old = f.owner.snapshot().generation;
    f.owner.invalidateTransfers();
    expect(f.owner.snapshot()).toMatchObject({ ownerLive: false, transfersReady: false, retainedInputBytes: 3 });
    expect(f.owner.run(request(old))).toMatchObject({ ok: false, failure: { code: "StaleGeneration" } });
    const current = f.owner.snapshot().generation;
    expect(f.owner.run(request(current))).toMatchObject({ ok: false, failure: { code: "TransfersUnavailable" } });
    f.owner.replaceTransfers(new Uint8Array(0));
    expect(f.owner.run(request(current))).toMatchObject({ ok: true }); expect(f.factory.mock.calls[1]![1]).toHaveLength(0);
    expect(() => f.owner.replaceTransfers(f.transfers)).toThrow(/not invalidated/);
  });

  it.each([
    ["duration-rebuild", false], ["timetable-prepared", false], ["timetable-prepared", true],
  ] as const)("forwards fixed caps and filters with %s, walking/transfer bounds %s", (prefixPolicy, walkingTransferBounds) => {
    const f = fixture(), req = { ...request(f.enable()), prefixPolicy, walkingTransferBounds, mobilityProfile: "wheelchair" as const,
      excludedModes: [3, 800], walkSpeedMps: 0.8, minTransferSecs: 180 };
    expect(f.owner.run(req).ok).toBe(true);
    expect(f.prepare.mock.calls[0]).toEqual([
      { entryStops: req.scope.entryStops, exitStops: req.scope.exitStops, date: "20261012", departureSecs: -300,
        maxRounds: 4, mobilityProfile: "wheelchair", excludedModes: [3, 800], walkSpeedMps: 0.8, minTransferSecs: 180 },
      { windowStart: -300, windowEnd: 1001, arrivalDeadline: 1000, objective: "m4", lookup: "lazy-cached",
        validation: "session", catalogue: "held-slice", traversal: "arrival-first", witnessComparison: "materialized-date-memo",
        frontierStorage: "event-indexed", prefixCertificate: prefixPolicy === "timetable-prepared" ? "timetable" : "duration",
        prefixSetup: prefixPolicy === "timetable-prepared" ? "prepared" : "rebuild", prefixBound: true, pointBound: true,
        staticBound: false, walkingBound: walkingTransferBounds, transferBound: walkingTransferBounds, forwardSeeds: false,
        maxSegments: 250000, maxFrontierWidth: 64, maxStopScans: 10000000, maxLookupWork: 10000000 },
    ]);
    expect(f.run).toHaveBeenCalledWith("portfolio", "row-prefix");
    expect(f.prepare.mock.calls[0]![0]).not.toBe(req.scope);
  });

  it.each(ARRIVE_BY_SELECTORS)("accepts a complete %s result", (goal) => {
    const f = fixture(); expect(f.owner.run({ ...request(f.enable()), goal })).toMatchObject({ ok: true, latestScan: null });
    expect(f.run).toHaveBeenCalledWith(goal, "row-prefix"); expect(f.scan).not.toHaveBeenCalled(); expect(f.selector).not.toHaveBeenCalled();
  });

  it("distinguishes a genuine empty result from every failed stage", () => {
    const f = fixture(); f.run.mockImplementation((goal) => output(goal, true));
    expect(f.owner.run(request(f.enable()))).toMatchObject({ ok: true, options: [] });
    f.run.mockImplementationOnce(() => { throw new Error("deadline winner journey: LookupWorkLimit"); });
    const failed = f.owner.run(request(f.owner.snapshot().generation));
    expect(failed).toMatchObject({ ok: false, failure: { stage: "search", code: "WinnerJourneyFailed", message: "deadline winner journey: LookupWorkLimit" } });
    expect(failed).not.toHaveProperty("options"); expect(f.owner.snapshot().ownerLive).toBe(false);
  });

  it.each([
    ["constructor", "setup", "OwnerConstructionFailed"], ["prepare", "prepare", "PreparationFailed"],
    ["search", "search", "WinnerJourneyFailed"], ["decode", "contract", "InvalidMovement"],
  ])("fails closed and can retry after %s failure", (fault, stage, code) => {
    const f = fixture(), generation = f.enable();
    if (fault === "constructor") f.factory.mockImplementationOnce(() => { throw new Error("construct fault"); });
    if (fault === "prepare") f.prepare.mockImplementationOnce(() => { throw new Error("prepare fault"); });
    if (fault === "search") f.run.mockImplementationOnce(() => { throw new Error("search fault"); });
    if (fault === "decode") f.run.mockImplementationOnce(() => ({ ...output(), complete: false }));
    const result = f.owner.run(request(generation));
    expect(result).toMatchObject({ ok: false, failure: { stage, code }, state: { ownerLive: false } });
    expect(result).not.toHaveProperty("options");
    expect(f.free).toHaveBeenCalledTimes(fault === "constructor" ? 0 : 1);
    expect(f.owner.run(request(generation)).ok).toBe(true);
  });

  describe("request reset after typed resource limits", () => {
    it.each(ARRIVE_BY_RESOURCE_LIMITS.flatMap((tag) => (["prepare", "search"] as const).map((stage) => ({ tag, stage }))))(
      "resets $stage $tag without retrying the failed request", ({ tag, stage }) => {
        const f = fixture(true), req = request(f.enable());
        (stage === "prepare" ? f.prepare : f.run).mockImplementationOnce(() => {
          throw Object.assign(new Error("capped"), { ptnResourceLimit: tag });
        });
        const failed = f.owner.run(req);
        expect(failed).toMatchObject({ ok: false, failure: { stage, code: "ResourceLimit", resourceLimit: tag },
          state: { ownerLive: true, constructions: 1, retirements: 0 } });
        expect(f.clear).toHaveBeenCalledTimes(1); expect(f.free).not.toHaveBeenCalled();
        expect(f.prepare).toHaveBeenCalledTimes(1);
        expect(f.run).toHaveBeenCalledTimes(stage === "prepare" ? 0 : 1);
        expect(failed.marks.resetEnd).toBeGreaterThanOrEqual(failed.marks.resetStart!);
        expect(f.owner.run(req)).toMatchObject({ ok: true, state: { constructions: 1 } });
        expect(f.prepare).toHaveBeenCalledTimes(2);
      });

    it("retires on reset failure and removes recoverable metadata", () => {
      const f = fixture(true), req = request(f.enable());
      f.run.mockImplementationOnce(() => { throw Object.assign(new Error("capped"), { ptnResourceLimit: "lookup-work" }); });
      f.clear.mockImplementationOnce(() => { throw new Error("reset fault"); });
      const failed = f.owner.run(req);
      expect(failed).toMatchObject({ ok: false, failure: { stage: "setup", code: "OwnerResetFailed" }, state: { ownerLive: false } });
      if (!failed.ok) expect(failed.failure.resourceLimit).toBeUndefined();
      expect(f.free).toHaveBeenCalledTimes(1);
      expect(f.owner.run(req)).toMatchObject({ ok: true, state: { constructions: 2 } });
    });

    it("poisons the host if both reset and retirement fail", () => {
      const f = fixture(true), req = request(f.enable());
      f.run.mockImplementationOnce(() => { throw Object.assign(new Error("capped"), { ptnResourceLimit: "lookup-work" }); });
      f.clear.mockImplementationOnce(() => { throw new Error("reset fault"); });
      f.free.mockImplementationOnce(() => { throw new Error("free fault"); });
      const failed = f.owner.run(req);
      expect(failed).toMatchObject({ ok: false, failure: { stage: "setup", code: "OwnerRetirementFailed" }, state: { poisoned: true } });
      if (!failed.ok) expect(failed.failure.resourceLimit).toBeUndefined();
      expect(f.owner.run(req)).toMatchObject({ ok: false, failure: { code: "OwnerPoisoned" } });
      expect(f.factory).toHaveBeenCalledTimes(1);
    });

    it("retires typed errors outside prepare/search without clearing", () => {
      const f = fixture(true), raw = output();
      Object.defineProperty(raw, "complete", { get() { throw Object.assign(new Error("decode fault"), { ptnResourceLimit: "lookup-work" }); } });
      f.run.mockReturnValueOnce(raw);
      const failed = f.owner.run(request(f.enable()));
      expect(failed).toMatchObject({ ok: false, failure: { stage: "contract" }, state: { ownerLive: false } });
      if (!failed.ok) expect(failed.failure.resourceLimit).toBeUndefined();
      expect(f.clear).not.toHaveBeenCalled(); expect(f.free).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, "unknown"])("retires unclassified errors (%s) without clearing", (tag) => {
      const f = fixture(true);
      f.run.mockImplementationOnce(() => { throw Object.assign(new Error("LookupWorkLimit"), { ptnResourceLimit: tag }); });
      expect(f.owner.run(request(f.enable()))).toMatchObject({ ok: false, state: { ownerLive: false } });
      expect(f.clear).not.toHaveBeenCalled(); expect(f.free).toHaveBeenCalledTimes(1);
    });

    it.each(["disable", "transfers"])("retires a recovered owner on %s", (change) => {
      const f = fixture(true), req = request(f.enable());
      f.run.mockImplementationOnce(() => { throw Object.assign(new Error("capped"), { ptnResourceLimit: "lookup-work" }); });
      f.owner.run(req);
      if (change === "disable") f.owner.setEnabled(false); else f.owner.invalidateTransfers();
      expect(f.free).toHaveBeenCalledTimes(1);
      expect(f.owner.run(req)).toMatchObject({ ok: false, state: { ownerLive: false } });
    });
  });

  it.each(["prepare", "search"] as const)("preserves structured resource metadata from %s", (stage) => {
    const f = fixture(), generation = f.enable();
    const error = Object.assign(new Error("arbitrary text"), { ptnResourceLimit: "lookup-work" });
    (stage === "prepare" ? f.prepare : f.run).mockImplementationOnce(() => { throw error; });
    expect(f.owner.run(request(generation))).toMatchObject({ ok: false,
      failure: { stage, code: "ResourceLimit", resourceLimit: "lookup-work", message: "arbitrary text" } });
  });

  it("does not classify cap-like text or unknown metadata as recoverable", () => {
    for (const error of [new Error("WorkExhausted"), Object.assign(new Error("cap"), { ptnResourceLimit: "unknown" })]) {
      const f = fixture(), generation = f.enable();
      f.run.mockImplementationOnce(() => { throw error; });
      const result = f.owner.run(request(generation));
      expect(result).toMatchObject({ ok: false, failure: { code: "WinnerJourneyFailed" } });
      if (!result.ok) expect(result.failure.resourceLimit).toBeUndefined();
    }
  });

  it("retirement failure overrides an otherwise recoverable resource limit", () => {
    const f = fixture(), generation = f.enable();
    f.run.mockImplementationOnce(() => { throw Object.assign(new Error("cap"), { ptnResourceLimit: "segments" }); });
    f.free.mockImplementationOnce(() => { throw new Error("free failed"); });
    const result = f.owner.run(request(generation));
    expect(result).toMatchObject({ ok: false, failure: { code: "OwnerRetirementFailed" } });
    if (!result.ok) expect(result.failure.resourceLimit).toBeUndefined();
  });

  it("a destructor fault poisons the extension and never constructs another owner", () => {
    const f = fixture(), generation = f.enable(); f.owner.run(request(generation));
    f.free.mockImplementationOnce(() => { throw new Error("free fault"); });
    expect(() => f.owner.setEnabled(false)).toThrow("free fault");
    const next = f.enable();
    expect(f.owner.run(request(next))).toMatchObject({ ok: false, failure: { code: "OwnerPoisoned" }, state: { poisoned: true, ownerLive: false } });
    expect(f.factory).toHaveBeenCalledTimes(1); expect(f.free).toHaveBeenCalledTimes(1);
  });

  it("preserves the original failure message when retirement also fails", () => {
    const f = fixture(), generation = f.enable();
    f.run.mockImplementationOnce(() => { throw new Error("StopWorkLimit"); });
    f.free.mockImplementationOnce(() => { throw new Error("free fault"); });
    expect(f.owner.run(request(generation))).toMatchObject({ ok: false,
      failure: { code: "OwnerRetirementFailed", message: "StopWorkLimit; retirement failed: free fault" } });
  });

  it.each([
    (r: ArriveByOwnerRequest) => ({ ...r, generation: NaN }),
    (r: ArriveByOwnerRequest) => ({ ...r, maxStopScans: 99999999 }),
    (r: ArriveByOwnerRequest) => ({ ...r, goal: "skyline" }),
    (r: ArriveByOwnerRequest) => ({ ...r, prefixPolicy: "unregistered" }),
    (r: ArriveByOwnerRequest) => ({ ...r, mobilityProfile: "flying" }),
    (r: ArriveByOwnerRequest) => ({ ...r, excludedModes: [65536] }),
    (r: ArriveByOwnerRequest) => ({ ...r, walkSpeedMps: 0 }),
    (r: ArriveByOwnerRequest) => ({ ...r, walkSpeedMps: NaN }),
    (r: ArriveByOwnerRequest) => ({ ...r, minTransferSecs: 3601 }),
    (r: ArriveByOwnerRequest) => { const { minTransferSecs: _, ...rest } = r; return rest; },
    (r: ArriveByOwnerRequest) => ({ ...r, scope: { ...r.scope, serviceDate: 42 } }),
    (r: ArriveByOwnerRequest) => ({ ...r, scope: { ...r.scope, windowStart: 1001 } }),
    (r: ArriveByOwnerRequest) => ({ ...r, scope: { ...r.scope, arrivalDeadline: 999 } }),
    (r: ArriveByOwnerRequest) => ({ ...r, scope: { ...r.scope, maxRounds: 5 } }),
    (r: ArriveByOwnerRequest) => ({ ...r, scope: { ...r.scope, entryStops: [{ stopId: "A", walkSecs: -1 }] } }),
  ])("rejects malformed or cap-changing input before touching a live owner (%#)", (mutate) => {
    const f = fixture(), req = request(f.enable()); f.owner.run(req);
    const failed = f.owner.run(mutate(req) as ArriveByOwnerRequest);
    expect(failed).toMatchObject({ ok: false, failure: { stage: "contract", code: "InvalidRequest" }, state: { ownerLive: true } });
    expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.free).not.toHaveBeenCalled();
  });
});

describe("building the owner without a query (H74 warm-up)", () => {
  it("builds once, is a no-op while live, and fails typed when unavailable", () => {
    const f = fixture();
    expect(f.owner.construct()).toMatchObject({ ok: false, failure: { stage: "availability", code: "Disabled" } });
    f.enable();
    const built = f.owner.construct();
    expect(built).toMatchObject({ ok: true, marks: { constructorCopyBytes: 3 } });
    expect(f.owner.construct()).toMatchObject({ ok: true, marks: {} });
    expect((f.owner.construct() as { marks: ArriveByOwnerMarks }).marks.constructStart).toBeUndefined();
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.owner.snapshot()).toMatchObject({ ownerLive: true, constructions: 1 });
    f.owner.invalidateTransfers();
    expect(f.owner.construct()).toMatchObject({ ok: false, failure: { code: "TransfersUnavailable" } });
  });
});

describe("the owner worker host (H74)", () => {
  function host(resettable = false) {
    const f = fixture(resettable);
    const attach = vi.fn((bytes: Uint8Array, mode: string, city: string) => new ArriveByWorkerOwner(f.factory, bytes, mode, city));
    const load = vi.fn(async () => undefined);
    return { ...f, attach, load, handle: createArriveByOwnerHost({ attach, load }) };
  }
  const init = { id: 0, op: "init" as const, bytes: new Uint8Array([1, 2, 3]).buffer, mode: "covering-merge", city: "vilnius" };

  it("returns a typed failure with a live reset owner, then processes the next request", async () => {
    const f = host(true), handle = f.handle;
    await handle(init); await handle({ id: 1, op: "setArriveByEnabled", enabled: true });
    f.run.mockImplementationOnce(() => { throw Object.assign(new Error("capped"), { ptnResourceLimit: "lookup-work" }); });
    expect(await handle({ id: 2, op: "arriveBy", request: request(2) })).toMatchObject({ ok: true, value: {
      ok: false, failure: { code: "ResourceLimit", resourceLimit: "lookup-work" }, state: { ownerLive: true } } });
    expect(f.clear).toHaveBeenCalledTimes(1);
    expect(await handle({ id: 3, op: "arriveBy", request: request(2) })).toMatchObject({ ok: true, value: { ok: true, state: { constructions: 1 } } });
    expect(f.free).not.toHaveBeenCalled();
  });

  it("serializes init, enable, request, transfers, stale request, request and disable", async () => {
    const f = host(), handle = f.handle;
    const replies = await Promise.all([handle(init), handle({ id: 1, op: "setArriveByEnabled", enabled: true }),
      handle({ id: 2, op: "arriveBy", request: request(2) }),
      handle({ id: 3, op: "invalidateTransfers" }), handle({ id: 4, op: "replaceTransfers", bytes: new Uint8Array([8]).buffer }),
      handle({ id: 5, op: "arriveBy", request: request(2) }), handle({ id: 6, op: "arriveBy", request: request(3) }),
      handle({ id: 7, op: "setArriveByEnabled", enabled: false })]);
    expect(replies.map((x) => x.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(replies[0]).toStrictEqual({ id: 0, ok: true });
    expect(replies[2]).toMatchObject({ ok: true, value: { ok: true } });
    expect(replies[3]).toMatchObject({ ok: true, value: { generation: 3, transfersReady: false, ownerLive: false } });
    expect(replies[4]).toMatchObject({ ok: true, value: { generation: 3, transfersReady: true, ownerLive: false } });
    expect(replies[5]).toMatchObject({ ok: true, value: { ok: false, failure: { code: "StaleGeneration" } } });
    expect(replies[6]).toMatchObject({ ok: true, value: { ok: true } });
    expect(replies[7]).toMatchObject({ value: { ownerLive: false, retainedInputBytes: 4 } });
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.factory).toHaveBeenCalledTimes(2); expect(f.free).toHaveBeenCalledTimes(2);
    expect([...f.factory.mock.calls[1]![1]]).toEqual([8]);
    expect(structuredClone(replies)).toEqual(replies);
  });

  it("without the replacement (the router's update failed), requests fail as TransfersUnavailable until one arrives", async () => {
    const f = host(), handle = f.handle; await handle(init);
    await handle({ id: 1, op: "setArriveByEnabled", enabled: true }); await handle({ id: 2, op: "arriveBy", request: request(2) });
    expect(await handle({ id: 3, op: "invalidateTransfers" })).toMatchObject({ ok: true, value: { transfersReady: false } });
    expect(f.free).toHaveBeenCalledTimes(1);
    expect(await handle({ id: 4, op: "arriveBy", request: request(3) })).toMatchObject({ value: { ok: false, failure: { code: "TransfersUnavailable" } } });
    await handle({ id: 5, op: "invalidateTransfers" });
    await handle({ id: 6, op: "replaceTransfers", bytes: new ArrayBuffer(0) });
    expect(await handle({ id: 7, op: "arriveBy", request: request(4) })).toMatchObject({ value: { ok: true } });
  });

  it("a broken destructor answers the invalidation with its error and poisons the owner", async () => {
    const f = host(), handle = f.handle; await handle(init);
    await handle({ id: 1, op: "setArriveByEnabled", enabled: true }); await handle({ id: 2, op: "arriveBy", request: request() });
    f.free.mockImplementationOnce(() => { throw new Error("free fault"); });
    expect(await handle({ id: 3, op: "invalidateTransfers" })).toMatchObject({ ok: false, error: "free fault" });
    await handle({ id: 4, op: "replaceTransfers", bytes: new ArrayBuffer(1) });
    expect(await handle({ id: 5, op: "arriveBy", request: request(3) })).toMatchObject({ value: { ok: false, failure: { code: "OwnerPoisoned" } } });
  });

  it("a failed attachment answers init and every later request with its error, without breaking the queue", async () => {
    const f = host(); f.attach.mockImplementationOnce(() => { throw new Error("snapshot fault"); });
    expect(await f.handle(init)).toMatchObject({ ok: false, error: "arrive-by owner failed to attach: snapshot fault" });
    expect(await f.handle({ id: 1, op: "setArriveByEnabled", enabled: true }))
      .toMatchObject({ ok: false, error: "arrive-by owner failed to attach: snapshot fault" });
    expect(await f.handle({ id: 2, op: "arriveByCancelWarm" })).toStrictEqual({ id: 2, ok: true });
    expect(f.load).not.toHaveBeenCalled();
  });

  it("an empty city binding fails the attachment", async () => {
    const f = host();
    expect(await f.handle({ ...init, city: "" })).toMatchObject({ ok: false, error: "arrive-by owner failed to attach: missing city binding" });
  });

  it("a warm-up builds the owner first and drops its query for a request that arrived meanwhile", async () => {
    const f = host(), handle = f.handle; await handle(init);
    await handle({ id: 1, op: "setArriveByEnabled", enabled: true });
    const body = (({ generation: _g, ...rest }) => rest)(request());
    // The search's request arrives while the owner is being built.
    let behind: Promise<unknown> | undefined;
    f.factory.mockImplementationOnce((...args) => {
      behind = handle({ id: 3, op: "arriveBy", request: request(2) });
      return f.factory.getMockImplementation()!(...args);
    });
    expect(await handle({ id: 2, op: "arriveByWarm", request: body })).toStrictEqual({ id: 2, ok: true, value: { dropped: true, constructed: true } });
    expect(await behind).toMatchObject({ ok: true, value: { ok: true, state: { constructions: 1 } } });
    expect(f.factory).toHaveBeenCalledTimes(1); expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("a warm-up with nothing behind it runs its query, with the construction in its marks", async () => {
    const f = host(), handle = f.handle; await handle(init);
    await handle({ id: 1, op: "setArriveByEnabled", enabled: true });
    const body = (({ generation: _g, ...rest }) => rest)(request());
    const reply = await handle({ id: 2, op: "arriveByWarm", request: body });
    expect(reply).toMatchObject({ ok: true, value: { dropped: false, request: { generation: 2 }, outcome: { ok: true } } });
    const marks = (reply as { value: { outcome: { marks: ArriveByOwnerMarks } } }).value.outcome.marks;
    expect(marks.constructStart).toBeLessThanOrEqual(marks.constructEnd!);
    expect(marks.start).toBeLessThanOrEqual(marks.constructStart!);
    expect(marks.prepareStart).toBeGreaterThanOrEqual(marks.constructEnd!);
    // A second warm-up finds the owner live: no construction marks.
    const again = await handle({ id: 3, op: "arriveByWarm", request: body });
    expect((again as { value: { outcome: { marks: ArriveByOwnerMarks } } }).value.outcome.marks.constructStart).toBeUndefined();
    expect(f.factory).toHaveBeenCalledTimes(1);
  });

  it("a warm-up whose construction fails answers with that failure, typed", async () => {
    const f = host(), handle = f.handle; await handle(init);
    await handle({ id: 1, op: "setArriveByEnabled", enabled: true });
    f.factory.mockImplementationOnce(() => { throw new Error("out of memory"); });
    const body = (({ generation: _g, ...rest }) => rest)(request());
    expect(await handle({ id: 2, op: "arriveByWarm", request: body })).toMatchObject({ ok: true, value: { dropped: false,
      outcome: { ok: false, failure: { stage: "setup", code: "OwnerConstructionFailed", message: "out of memory" }, state: { poisoned: false, ownerLive: false } } } });
    expect(await handle({ id: 3, op: "arriveBy", request: request(2) })).toMatchObject({ value: { ok: true } });
  });

  it("a failed runtime load answers the enable, leaves the owner disabled, and a later enable retries", async () => {
    const f = host(), handle = f.handle; await handle(init);
    f.load.mockRejectedValueOnce(new Error("offline"));
    expect(await handle({ id: 1, op: "setArriveByEnabled", enabled: true }))
      .toMatchObject({ ok: false, error: "arrive-by runtime failed to load: offline" });
    expect(await handle({ id: 2, op: "arriveBy", request: request(1) })).toMatchObject({ value: { ok: false, failure: { code: "Disabled" } } });
    expect(await handle({ id: 3, op: "setArriveByEnabled", enabled: true })).toMatchObject({ ok: true, value: { enabled: true, generation: 2 } });
    // Disabling never loads.
    expect(await handle({ id: 4, op: "setArriveByEnabled", enabled: false })).toMatchObject({ ok: true });
    expect(f.load).toHaveBeenCalledTimes(2);
  });
});

describe("H58 reverse first stage for the latest request", () => {
  const latest = (generation: number): ArriveByOwnerRequest =>
    ({ ...request(generation), goal: "latest-departure", latestStage: "reverse-scan", prefixPolicy: "timetable-prepared" });
  const windowOf = (call: unknown[] | undefined) => {
    const o = call![1] as { windowStart: number; windowEnd: number }; return [o.windowStart, o.windowEnd];
  };

  it("scans, then certifies the latest winner on [D, D + 1) with the same query and caps", () => {
    const f = fixture(), result = f.owner.run(latest(f.enable()));
    expect(result).toMatchObject({ ok: true, latestScan: { outcome: "narrowed", departure: -200, optimum: null, outOfScope: null,
      error: null, indexBuilt: true, scanIndexBytes: 2048 } });
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.options).toHaveLength(1); expect(result.options[0]!.selectors).toEqual(["latest-departure"]);
    expect(result.options[0]!.journey.point.departureSecs).toBe(-200);
    expect(f.scan).toHaveBeenCalledTimes(1); expect(f.selector).not.toHaveBeenCalled();
    const [query, start, end, deadline] = f.scan.mock.calls[0]!;
    expect([start, end, deadline]).toEqual([-300, 1001, 1000]);
    expect(query).toEqual(f.prepare.mock.calls[0]![0]);
    expect(windowOf(f.prepare.mock.calls[0])).toEqual([-200, -199]);
    // Only the window and its optimistic prefix certificate change.
    const full = fixture(); full.owner.run({ ...request(full.enable()), goal: "latest-departure", prefixPolicy: "timetable-prepared" });
    expect({ ...(f.prepare.mock.calls[0]![1] as object), windowStart: -300, windowEnd: 1001, prefixCertificate: "timetable" }).toEqual(full.prepare.mock.calls[0]![1]);
    expect(f.prepare.mock.calls[0]![1]).toMatchObject({ prefixCertificate: "duration", prefixSetup: "prepared" });
    const m = result.marks;
    expect([m.start, m.scanStart, m.scanEnd, m.prepareStart, m.prepareEnd, m.searchStart, m.searchEnd, m.decodeEnd, m.end])
      .toEqual([m.start, m.scanStart, m.scanEnd, m.prepareStart, m.prepareEnd, m.searchStart, m.searchEnd, m.decodeEnd, m.end].sort((a, b) => a! - b!));
    expect(Object.isFrozen(result.latestScan)).toBe(true);
  });

  it.each([
    ["no departure", () => scanWire(null), "no-departure", null],
    ["out of the scan's scope", () => scanWire(null, "explicit transfer rules"), "out-of-scope", null],
    ["a scan error", () => { throw new Error("latest scan: IncompleteHorizon"); }, "scan-failed", "latest scan: IncompleteHorizon"],
  ] as const)("falls back to the full window after %s", (_name, wire, outcome, error) => {
    const f = fixture(); f.scan.mockImplementation(wire);
    const result = f.owner.run(latest(f.enable()));
    expect(result).toMatchObject({ ok: true, latestScan: { outcome, error }, state: { ownerLive: true } });
    expect(windowOf(f.prepare.mock.calls[0])).toEqual([-300, 1001]);
    expect(f.prepare.mock.calls[0]![1]).toMatchObject({ prefixCertificate: "timetable", prefixSetup: "prepared" });
    expect(f.free).not.toHaveBeenCalled();
  });

  it("falls back when the build has no scan", () => {
    const f = fixture();
    f.factory.mockImplementationOnce(() => ({ prepare: f.prepare, run_winner_journeys: f.run, free: f.free }) as never);
    expect(f.owner.run(latest(f.enable()))).toMatchObject({ ok: true,
      latestScan: { outcome: "scan-failed", error: "owner has no latest scan", scanIndexBytes: null } });
    expect(windowOf(f.prepare.mock.calls[0])).toEqual([-300, 1001]);
  });

  it.each([
    { ...scanWire(), schema: "latest-scan-v0" },
    { ...scanWire(), window: [-299, 1001] },
    { ...scanWire(), arrivalDeadline: 999 },
    scanWire(1001), scanWire(-301), scanWire(-200.5),
    scanWire(-200, "frequencies"), scanWire(null, ""),
    { ...scanWire(), scanIndexBytes: -1 }, { ...scanWire(), indexBuilt: "yes" }, null,
    selectorWire("fewest-transfers"),
  ])("fails closed on a malformed scan before preparing (%#)", (wire) => {
    const f = fixture(); f.scan.mockReturnValueOnce(wire);
    const result = f.owner.run(latest(f.enable()));
    expect(result).toMatchObject({ ok: false, failure: { stage: "contract", code: "InvalidLatestScan" },
      latestScan: null, state: { ownerLive: false } });
    expect(result).not.toHaveProperty("options"); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("a scan departure the selector cannot certify is a failure, not an empty result", () => {
    const f = fixture(); f.run.mockImplementationOnce((goal) => output(goal, true, [-200, -199]));
    const result = f.owner.run(latest(f.enable()));
    expect(result).toMatchObject({ ok: false, failure: { stage: "contract", code: "LatestScanMismatch" },
      latestScan: { outcome: "narrowed", departure: -200 }, state: { ownerLive: false } });
    expect(result).not.toHaveProperty("options");
  });

  it("an empty full-window fallback is a genuine empty result", () => {
    const f = fixture(); f.scan.mockReturnValueOnce(scanWire(null)); f.run.mockImplementationOnce((goal) => output(goal, true));
    expect(f.owner.run(latest(f.enable()))).toMatchObject({ ok: true, options: [], latestScan: { outcome: "no-departure" } });
  });

  it("a narrowed result that fails to decode is a movement failure", () => {
    const f = fixture(); f.run.mockImplementationOnce((goal) => output(goal, false, [-300, 1001]));
    expect(f.owner.run(latest(f.enable()))).toMatchObject({ ok: false, failure: { stage: "contract", code: "InvalidMovement" } });
  });

  it.each([
    (r: ArriveByOwnerRequest) => ({ ...r, goal: "portfolio" }),
    (r: ArriveByOwnerRequest) => ({ ...r, goal: "fastest" }),
    (r: ArriveByOwnerRequest) => ({ ...r, latestStage: "backward" }),
    (r: ArriveByOwnerRequest) => { const { latestStage: _, ...rest } = r; return rest; },
    (r: ArriveByOwnerRequest) => { const { walkingTransferBounds: _, ...rest } = r; return rest; },
    (r: ArriveByOwnerRequest) => ({ ...r, walkingTransferBounds: "yes" }),
  ])("rejects a reverse stage outside the scan selectors, or a malformed bound flag, before the scan (%#)", (mutate) => {
    const f = fixture(), generation = f.enable();
    expect(f.owner.run(mutate(latest(generation)) as ArriveByOwnerRequest))
      .toMatchObject({ ok: false, failure: { stage: "contract", code: "InvalidRequest" }, latestScan: null });
    expect(f.scan).not.toHaveBeenCalled(); expect(f.selector).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled();
  });

  it("passes the scan receipt through the owner worker host", async () => {
    const f = fixture(), handle = createArriveByOwnerHost({ load: async () => undefined,
      attach: (bytes, mode, city) => new ArriveByWorkerOwner(f.factory, bytes, mode, city) });
    await handle({ id: 0, op: "init", bytes: new Uint8Array([1]).buffer, mode: "covering-merge", city: "vilnius" });
    await handle({ id: 1, op: "setArriveByEnabled", enabled: true });
    const reply = await handle({ id: 2, op: "arriveBy", request: latest(2) });
    expect(reply).toMatchObject({ ok: true, value: { ok: true, latestScan: { outcome: "narrowed", departure: -200 } } });
    expect(structuredClone(reply)).toEqual(reply);
  });
});

describe("H81 reverse first stage for fewest transfers and least walking", () => {
  type ScanGoal = "fewest-transfers" | "least-walking";
  const GOALS = ["fewest-transfers", "least-walking"] as const;
  const optimumOf = (goal: ScanGoal) => (goal === "fewest-transfers" ? 0 : 100);
  const selectorRequest = (generation: number, goal: ScanGoal): ArriveByOwnerRequest =>
    ({ ...request(generation), goal, latestStage: "reverse-scan", prefixPolicy: "timetable-prepared", walkingTransferBounds: true });
  const windowOf = (call: unknown[] | undefined) => {
    const o = call![1] as { windowStart: number; windowEnd: number }; return [o.windowStart, o.windowEnd];
  };

  it.each(GOALS)("scans %s, then certifies its winner on [D, D + 1) with the same query, caps and bounds", (goal) => {
    const f = fixture(), result = f.owner.run(selectorRequest(f.enable(), goal));
    expect(result).toMatchObject({ ok: true, latestScan: { outcome: "narrowed", departure: -200, optimum: optimumOf(goal),
      outOfScope: null, error: null, indexBuilt: true, scanIndexBytes: 2048 } });
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.options).toHaveLength(1); expect(result.options[0]!.selectors).toEqual([goal]);
    expect(f.scan).not.toHaveBeenCalled(); expect(f.selector).toHaveBeenCalledTimes(1);
    const [scanGoal, query, start, end, deadline] = f.selector.mock.calls[0]!;
    expect([scanGoal, start, end, deadline]).toEqual([goal, -300, 1001, 1000]);
    expect(query).toEqual(f.prepare.mock.calls[0]![0]);
    expect(windowOf(f.prepare.mock.calls[0])).toEqual([-200, -199]);
    expect(f.run).toHaveBeenCalledWith(goal, "row-prefix");
    // Only the window and its optimistic prefix certificate change.
    const full = fixture();
    full.owner.run({ ...selectorRequest(full.enable(), goal), latestStage: "full-window" });
    expect({ ...(f.prepare.mock.calls[0]![1] as object), windowStart: -300, windowEnd: 1001, prefixCertificate: "timetable" })
      .toEqual(full.prepare.mock.calls[0]![1]);
    expect(f.prepare.mock.calls[0]![1]).toMatchObject({ prefixCertificate: "duration", walkingBound: true, transferBound: true });
    expect(Object.isFrozen(result.latestScan)).toBe(true);
  });

  it.each(GOALS)("a %s winner without the scan's optimum is a failure, not a result", (goal) => {
    const f = fixture(); f.selector.mockReturnValueOnce(selectorWire(goal, optimumOf(goal) + 1));
    const result = f.owner.run(selectorRequest(f.enable(), goal));
    expect(result).toMatchObject({ ok: false, failure: { stage: "contract", code: "SelectorScanMismatch" },
      latestScan: { outcome: "narrowed", departure: -200, optimum: optimumOf(goal) + 1 }, state: { ownerLive: false } });
    expect(result).not.toHaveProperty("options");
  });

  it("a scan departure the selector cannot certify is a failure, not an empty result", () => {
    const f = fixture(); f.run.mockImplementationOnce((goal) => output(goal, true, [-200, -199]));
    expect(f.owner.run(selectorRequest(f.enable(), "least-walking")))
      .toMatchObject({ ok: false, failure: { stage: "contract", code: "SelectorScanMismatch" } });
  });

  it.each([
    ["no departure", (g: ScanGoal) => selectorWire(g, null), "no-departure", null],
    ["out of the scan's scope", (g: ScanGoal) => selectorWire(g, null, null, "frequencies"), "out-of-scope", null],
    ["a scan error", () => { throw new Error("selector scan: IncompleteHorizon"); }, "scan-failed", "selector scan: IncompleteHorizon"],
  ] as const)("falls back to the full window after %s", (_name, wire, outcome, error) => {
    for (const goal of GOALS) {
      const f = fixture(); f.selector.mockImplementation((g: string) => wire(g as ScanGoal));
      expect(f.owner.run(selectorRequest(f.enable(), goal)))
        .toMatchObject({ ok: true, latestScan: { outcome, error, optimum: null }, state: { ownerLive: true } });
      expect(windowOf(f.prepare.mock.calls[0])).toEqual([-300, 1001]);
      expect(f.prepare.mock.calls[0]![1]).toMatchObject({ prefixCertificate: "timetable", walkingBound: true, transferBound: true });
    }
  });

  it("falls back when the build has no selector scan", () => {
    const f = fixture();
    f.factory.mockImplementationOnce(() => ({ prepare: f.prepare, run_winner_journeys: f.run, latestDeparture: f.scan, free: f.free }) as never);
    expect(f.owner.run(selectorRequest(f.enable(), "fewest-transfers"))).toMatchObject({ ok: true,
      latestScan: { outcome: "scan-failed", error: "owner has no selector scan", scanIndexBytes: null } });
    expect(windowOf(f.prepare.mock.calls[0])).toEqual([-300, 1001]); expect(f.scan).not.toHaveBeenCalled();
  });

  it.each([
    { ...selectorWire("fewest-transfers"), schema: "latest-scan-v1" },
    { ...selectorWire("fewest-transfers"), goal: "least-walking" },
    { ...selectorWire("fewest-transfers"), window: [-299, 1001] },
    { ...selectorWire("fewest-transfers"), arrivalDeadline: 999 },
    selectorWire("fewest-transfers", 0, null), selectorWire("fewest-transfers", null, -200),
    selectorWire("fewest-transfers", -1), selectorWire("fewest-transfers", 0.5),
    { ...selectorWire("fewest-transfers"), optimum: "0" }, selectorWire("fewest-transfers", 0, 1001),
    selectorWire("fewest-transfers", 0, -200, "frequencies"), selectorWire("fewest-transfers", null, null, ""),
    { ...selectorWire("fewest-transfers"), scanIndexBytes: -1 }, scanWire(), null,
  ])("fails closed on a malformed selector scan before preparing (%#)", (wire) => {
    const f = fixture(); f.selector.mockReturnValueOnce(wire);
    const result = f.owner.run(selectorRequest(f.enable(), "fewest-transfers"));
    expect(result).toMatchObject({ ok: false, failure: { stage: "contract", code: "InvalidSelectorScan" },
      latestScan: null, state: { ownerLive: false } });
    expect(result).not.toHaveProperty("options"); expect(f.prepare).not.toHaveBeenCalled();
  });
});

describe("H86 fastest deadline bound", () => {
  // A window that ends before the deadline, as `fixed-start-24h` does; the
  // fixture's winner departs at -200 and arrives at 540.
  const fastest = (generation: number, durationBound: number | null): ArriveByOwnerRequest => {
    const r = request(generation);
    return { ...r, goal: "fastest", prefixPolicy: "timetable-prepared", walkingTransferBounds: true, durationBound,
      scope: { ...r.scope, windowEnd: 101 } };
  };
  const optionsOf = (call: unknown[] | undefined) => call![1] as Record<string, unknown>;

  it("searches to min(deadline, window end - 1 + bound) with the same window, prefix policy and caps", () => {
    const f = fixture(), result = f.owner.run(fastest(f.enable(), 700));
    expect(result).toMatchObject({ ok: true, latestScan: null });
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.options).toHaveLength(1); expect(result.options[0]!.selectors).toEqual(["fastest"]);
    const unbounded = fixture(); unbounded.owner.run(fastest(unbounded.enable(), null));
    expect(optionsOf(f.prepare.mock.calls[0])).toEqual({ ...optionsOf(unbounded.prepare.mock.calls[0]), arrivalDeadline: 800 });
    expect(optionsOf(f.prepare.mock.calls[0])).toMatchObject({ windowStart: -300, windowEnd: 101,
      prefixCertificate: "timetable", prefixSetup: "prepared", walkingBound: true, transferBound: true });
    expect(f.prepare.mock.calls[0]![0]).toEqual(unbounded.prepare.mock.calls[0]![0]);
    expect(f.run).toHaveBeenCalledWith("fastest", "row-prefix");
  });

  it.each([
    ["a bound past the deadline", 950, 101],
    ["any bound when the window ends at the deadline", 0, 1001],
  ])("leaves the search as it was for %s", (_name, bound, windowEnd) => {
    const f = fixture(), g = f.enable(), req = { ...fastest(g, bound), scope: { ...fastest(g, bound).scope, windowEnd } };
    const plain = fixture(), p = plain.enable();
    expect(f.owner.run(req)).toMatchObject({ ok: true });
    plain.owner.run({ ...req, generation: p, durationBound: null });
    expect(f.prepare.mock.calls[0]).toEqual(plain.prepare.mock.calls[0]);
    expect(optionsOf(f.prepare.mock.calls[0])).toMatchObject({ arrivalDeadline: 1000 });
  });

  it("a bounded search without exactly one winner is a contract failure, not an empty result", () => {
    const f = fixture(); f.run.mockImplementationOnce((goal) => output(goal, true, [-300, 101], 800));
    const result = f.owner.run(fastest(f.enable(), 700));
    expect(result).toMatchObject({ ok: false, failure: { stage: "contract", code: "FastestBoundMismatch" }, state: { ownerLive: false } });
    expect(result).not.toHaveProperty("options");
  });

  it.each([
    (r: ArriveByOwnerRequest) => ({ ...r, durationBound: -1 }),
    (r: ArriveByOwnerRequest) => ({ ...r, durationBound: 0.5 }),
    (r: ArriveByOwnerRequest) => ({ ...r, durationBound: "700" }),
    (r: ArriveByOwnerRequest) => ({ ...r, durationBound: Number.MAX_SAFE_INTEGER + 1 }),
    (r: ArriveByOwnerRequest) => { const { durationBound: _, ...rest } = r; return rest; },
    (r: ArriveByOwnerRequest) => ({ ...r, goal: "portfolio" }),
    (r: ArriveByOwnerRequest) => ({ ...r, goal: "latest-departure" }),
    (r: ArriveByOwnerRequest) => ({ ...r, goal: "fewest-transfers" }),
    (r: ArriveByOwnerRequest) => ({ ...r, goal: "least-walking", latestStage: "reverse-scan" }),
  ])("rejects a malformed bound, or a bound outside the full-window fastest stage, before the owner (%#)", (mutate) => {
    const f = fixture();
    expect(f.owner.run(mutate(fastest(f.enable(), 700)) as ArriveByOwnerRequest))
      .toMatchObject({ ok: false, failure: { stage: "contract", code: "InvalidRequest" }, latestScan: null });
    expect(f.factory).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });
});
