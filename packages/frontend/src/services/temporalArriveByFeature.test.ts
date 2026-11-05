import { describe, expect, it, vi } from "vitest";
import { createArriveByOwnerHost } from "./ptArriveByOwnerHost.ts";
import { createArriveByFeature, type ArriveByWasmModule } from "./temporalArriveByFeature.ts";
import type { ArriveByOwnerRequest } from "./temporalArriveByOwner.ts";
import { ARRIVE_BY_SELECTORS } from "./temporalArriveByResults.ts";

function request(generation: number): ArriveByOwnerRequest {
  return { generation, goal: "portfolio", latestStage: "full-window", prefixPolicy: "timetable-prepared", walkingTransferBounds: false,
    durationBound: null, mobilityProfile: "default", excludedModes: [], walkSpeedMps: 1.25, minTransferSecs: 120,
    scope: { serviceDate: 20261012, windowStart: 0, windowEnd: 1001, arrivalDeadline: 1000, maxRounds: 4,
      entryStops: [{ stopId: "A", walkSecs: 0 }], exitStops: [{ stopId: "X", walkSecs: 0 }] } };
}
function output() {
  const witness = { serviceDate: 20261012, routeIdx: 1, readerRouteIdx: 1, tripIdx: 1, boardPosition: 0,
    alightPosition: 1, boardSecs: 100, alightSecs: 500, frequencyOffsetSecs: 0, frequencyInstance: false, inSeat: false };
  const point = { departureSecs: 100, arrivalSecs: 500, totalWalkSecs: 0, actualTransfers: 0,
    transitRounds: 1, serviceDate: 20261012, witnessLegs: 1, witness: [witness] };
  return { scope: "deadline-winner-session-wasm-experiment", contract: "lexicographic-filter-winners-v1-no-arrival-floor",
    complete: true, completionScope: "fixed-selectors-only", queryKind: "portfolio", requestedWindow: [0, 1001],
    arrivalDeadline: 1000, winners: Object.fromEntries(ARRIVE_BY_SELECTORS.map((s) => [s, point])),
    journeyContract: "complete-selected-movement-v1",
    journeys: [{ point, access: { stopId: "A", walkSecs: 0 }, connections: [],
      rides: [{ witness, routeId: "R", routeShortName: "1", routeColor: null, tripId: "T", routeType: 3, mode: "BUS",
        fromStopId: "A", toStopId: "X", patternStopIds: ["A", "X"], approximate: false }],
      egress: { fromStopId: "X", exitStopId: "X", physicalWalkSecs: 0, callerWalkSecs: 0 } }],
    journeyByPreference: Object.fromEntries(ARRIVE_BY_SELECTORS.map((s) => [s, 0])) };
}

function wasm() {
  const constructed = vi.fn(), retained = vi.fn(), freed = vi.fn();
  class TemporalDeadlineProbe {
    constructor(ptb: Uint8Array, ptft: Uint8Array, mode: string) { constructed([...ptb], [...ptft], mode); }
    static withImmutableBinding(ptb: Uint8Array, ptft: Uint8Array, mode: string): TemporalDeadlineProbe {
      retained([...ptb], [...ptft], mode);
      return Object.create(TemporalDeadlineProbe.prototype) as TemporalDeadlineProbe;
    }
    prepare() { return undefined; }
    run_winner_journeys() { return output(); }
    free() { freed(); }
  }
  const init = vi.fn(async () => undefined);
  const mod: ArriveByWasmModule = { default: init, TemporalDeadlineProbe };
  const loadModule = vi.fn(async () => mod);
  return { mod, init, loadModule, constructed, retained, freed };
}

describe("opt-in arrive-by feature", () => {
  it("attaching snapshots the bundle and loads nothing", () => {
    const w = wasm(), feature = createArriveByFeature(w.loadModule);
    const owner = feature.attach(new Uint8Array([1, 2]), "covering-merge", "vilnius");
    expect(owner.snapshot()).toMatchObject({ city: "vilnius", enabled: false, ownerLive: false, retainedInputBytes: 2 });
    expect(w.loadModule).not.toHaveBeenCalled(); expect(feature.loaded()).toBe(false);
  });

  it("loads the package once, shares a concurrent load, then builds the owner lazily", async () => {
    const w = wasm(), feature = createArriveByFeature(w.loadModule);
    await Promise.all([feature.load(), feature.load()]); await feature.load();
    expect(w.loadModule).toHaveBeenCalledTimes(1); expect(w.init).toHaveBeenCalledTimes(1); expect(feature.loaded()).toBe(true);
    const owner = feature.attach(new Uint8Array([1, 2]), "covering-merge", "vilnius");
    const generation = owner.setEnabled(true).generation;
    expect(w.retained).not.toHaveBeenCalled();
    expect(owner.run(request(generation))).toMatchObject({ ok: true, state: { constructions: 1 } });
    expect(w.retained).toHaveBeenCalledWith([1, 2], [], "covering-merge");
  });

  // H84: the owner hashes the bundle, transfers and layout once, when it is
  // built, instead of in every prepare that does not reuse its catalogue.
  it("builds the owner with the retained binding, never the recomputing constructor", async () => {
    const w = wasm(), feature = createArriveByFeature(w.loadModule);
    await feature.load();
    const owner = feature.attach(new Uint8Array([3]), "covering-merge", "vilnius");
    expect(owner.run(request(owner.setEnabled(true).generation))).toMatchObject({ ok: true });
    expect(w.retained).toHaveBeenCalledTimes(1); expect(w.constructed).not.toHaveBeenCalled();
  });

  it("rejects a package whose probe has no retained-binding factory", async () => {
    class TemporalDeadlineProbe { constructor() {} }
    const feature = createArriveByFeature(async () => ({ default: async () => undefined, TemporalDeadlineProbe }) as unknown as ArriveByWasmModule);
    await expect(feature.load()).rejects.toThrow("no TemporalDeadlineProbe.withImmutableBinding"); expect(feature.loaded()).toBe(false);
  });

  it("a failed load stays unloaded and the next load retries", async () => {
    const w = wasm(), feature = createArriveByFeature(w.loadModule);
    w.init.mockRejectedValueOnce(new Error("offline"));
    await expect(feature.load()).rejects.toThrow("offline"); expect(feature.loaded()).toBe(false);
    await feature.load(); expect(feature.loaded()).toBe(true); expect(w.init).toHaveBeenCalledTimes(2);
  });

  it("rejects a package without the deadline probe", async () => {
    const feature = createArriveByFeature(async () => ({ default: async () => undefined }) as unknown as ArriveByWasmModule);
    await expect(feature.load()).rejects.toThrow("no TemporalDeadlineProbe"); expect(feature.loaded()).toBe(false);
  });

  it("an owner used before the load fails typed instead of throwing", () => {
    const w = wasm(), owner = createArriveByFeature(w.loadModule).attach(new Uint8Array([1]), "covering-merge", "vilnius");
    const failed = owner.run(request(owner.setEnabled(true).generation));
    expect(failed).toMatchObject({ ok: false, failure: { stage: "setup", code: "OwnerConstructionFailed",
      message: "arrive-by runtime is not loaded" } });
  });
});

describe("opt-in feature in the owner worker host", () => {
  function host() {
    const w = wasm(), feature = createArriveByFeature(w.loadModule);
    return { ...w, feature, handle: createArriveByOwnerHost(feature) };
  }
  const init = { id: 0, op: "init" as const, bytes: new Uint8Array([7]).buffer, mode: "covering-merge", city: "vilnius" };

  it("init does not load the package; the first enable does, before any request runs", async () => {
    const h = host();
    expect(await h.handle(init)).toMatchObject({ ok: true }); expect(h.loadModule).not.toHaveBeenCalled();
    const replies = await Promise.all([h.handle({ id: 1, op: "setArriveByEnabled", enabled: true }),
      h.handle({ id: 2, op: "arriveBy", request: request(2) })]);
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    expect(replies[0]).toMatchObject({ ok: true, value: { enabled: true, generation: 2 } });
    expect(replies[1]).toMatchObject({ ok: true, value: { ok: true, state: { constructions: 1 } } });
    expect(h.init).toHaveBeenCalledTimes(1);
    await h.handle({ id: 3, op: "setArriveByEnabled", enabled: false });
    await h.handle({ id: 4, op: "setArriveByEnabled", enabled: true });
    expect(h.loadModule).toHaveBeenCalledTimes(1); expect(h.freed).toHaveBeenCalledTimes(1);
  });

  it("a failed load answers the enable, keeps the feature disabled, and can be retried", async () => {
    const h = host(); await h.handle(init);
    h.init.mockRejectedValueOnce(new Error("offline"));
    expect(await h.handle({ id: 1, op: "setArriveByEnabled", enabled: true }))
      .toMatchObject({ ok: false, error: "arrive-by runtime failed to load: offline" });
    expect(await h.handle({ id: 2, op: "arriveBy", request: request(1) }))
      .toMatchObject({ ok: true, value: { ok: false, failure: { code: "Disabled" } } });
    expect(await h.handle({ id: 3, op: "setArriveByEnabled", enabled: true })).toMatchObject({ ok: true, value: { enabled: true } });
    expect(h.constructed).not.toHaveBeenCalled(); expect(h.retained).not.toHaveBeenCalled();
  });

  it("disabling or enabling before init never loads", async () => {
    const h = host();
    expect(await h.handle({ id: 0, op: "setArriveByEnabled", enabled: true })).toMatchObject({ ok: false, error: "arrive-by owner is not attached" });
    await h.handle({ ...init, id: 1 });
    expect(await h.handle({ id: 2, op: "setArriveByEnabled", enabled: false })).toMatchObject({ ok: true, value: { enabled: false } });
    expect(h.loadModule).not.toHaveBeenCalled();
  });
});
