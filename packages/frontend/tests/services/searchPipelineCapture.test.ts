import {describe, it, expect, vi} from "vitest";
import {SearchOrchestrator, type SearchConfig, type SearchQuery} from "../../src/services/searchOrchestrator.ts";
import {replaySearchPipeline, type PipelineCapture} from "../../src/services/searchPipelineCapture.ts";
import {planOnDevice, resolveDepartureOnDevice} from "../../src/services/wasmPlanner.ts";
import type {RaptorIndex} from "../../src/services/raptorIndex.ts";
vi.mock("../../src/services/wasmPlanner.ts", () => ({planOnDevice: vi.fn(async () => []), resolveDepartureOnDevice: vi.fn()}));
const stops = [{id: "A", name: "A", lat: 54.68, lon: 25.28}, {id: "B", name: "B", lat: 54.70, lon: 25.28}];
const query: SearchQuery = {origin: {lat: 54.68, lon: 25.28}, destination: {lat: 54.70, lon: 25.28},
  departureTime: new Date("2026-11-13T08:00:00+02:00"), ranking: "fastest", maxRounds: 3};
const route = {coords: [[25.28, 54.68], [25.28, 54.70]] as [number, number][], distanceMeters: 1000, steps: []};
const itineraries = [{boardSecs: 28850, alightSecs: 29000, transfers: 0, legs: [{type: "transit" as const,
  tripId: "T", routeId: "R", fromStopId: "A", toStopId: "B", departSecs: 28850, arriveSecs: 29000, boardStopIdx: 0, alightStopIdx: 1}]}];
function config(capture: (record: PipelineCapture) => void): SearchConfig {
  return {raptorIndex: {routes: [], routeIdToIdx: new Map(), routesAtStop: new Map(),
    services: new Map([["svc", {serviceId: "svc", days: [true,true,true,true,true,true,true], startDate: "20260101", endDate: "20271231", exceptions: {}}]])} as unknown as RaptorIndex,
    allStops: stops, cityId: "vilnius", feedTz: "Europe/Vilnius", getDelay: () => null,
    osrm: {isReady: () => false, table: vi.fn(), init: vi.fn(async () => {})} as never,
    directWalkRoute: async () => route, stopPlanner: async () => itineraries, pipelineCapture: capture};
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
describe("linked search observations", () => {
  it("captures actual orchestrator stages and replays them without live planners/providers", async () => {
    let record!: PipelineCapture;
    const reachObserver = vi.fn(), compositionObserver = vi.fn(), finalizationObserver = vi.fn();
    const options = {...config(r => {record = r;}), reachCapture: reachObserver, compositionCapture: compositionObserver, finalizationCapture: finalizationObserver};
    const output = await new SearchOrchestrator(options).search(query);
    expect(output.length).toBeGreaterThan(0);
    expect(record.planner?.source).toBe("injected");
    expect(record.planner?.query.entryStops).toEqual([{stopId: "A", walkSecs: 0}]);
    expect(record.planner?.output).toEqual(itineraries);
    expect(record.query.departureTimeMs).toBe(query.departureTime.getTime());
    expect(record).toHaveProperty("timeFrame");
    expect(record.composition.finalization).toHaveProperty("floorRules");
    expect(Object.isFrozen(record.composition.input)).toBe(true);
    expect(await replaySearchPipeline(record)).toEqual(output);
    expect(reachObserver).toHaveBeenCalledTimes(2);expect(compositionObserver).toHaveBeenCalledTimes(1);expect(finalizationObserver).toHaveBeenCalledTimes(1);
    for (const change of [
      (r: PipelineCapture) => {r.query.origin.lat += 0.01;},
      (r: PipelineCapture) => {r.query.departureTimeMs += 3600000;},
      (r: PipelineCapture) => {r.planner!.query.entryStops[0].walkSecs++;},
      (r: PipelineCapture) => {r.planner!.output[0].legs[0].arriveSecs++;},
      (r: PipelineCapture) => {r.planner = null;},
      (r: PipelineCapture) => {r.directRoute!.distanceMeters++;},
      (r: PipelineCapture) => {r.query.maxRounds = 9;},
    ]) {const changed = clone(record);change(changed);await expect(replaySearchPipeline(changed)).rejects.toThrow();}
  });
  it.each([
    ["spring DST", "2026-03-29T02:30:00+02:00", "2026-03-29T04:30:00+03:00"],
    ["repeated autumn hour", "2026-10-25T03:30:00+03:00", "2026-10-25T03:30:00+02:00"],
  ])("recomputes %s from retained absolute clock and feed zone", async (_label, first, second) => {
    const records: PipelineCapture[] = [];
    const search = new SearchOrchestrator({...config(r => records.push(r)), directWalkRoute: undefined, stopPlanner: async () => []});
    for (const departure of [first, second]) {
      await search.search({...query, departureTime: new Date(departure)});
      const record = records.at(-1)!;
      expect(record.timeFrame?.kind).toBe("timezone");expect(await replaySearchPipeline(record)).toEqual(record.output);
      const changed = clone(record);if (changed.timeFrame?.kind === "timezone") changed.timeFrame.timeZone = "UTC";
      await expect(replaySearchPipeline(changed)).rejects.toThrow();
    }
    expect(records[1].timeFrame!.departureSecs - records[0].timeFrame!.departureSecs).toBe(3600);
    expect(records[1].timeFrame!.serviceDate).toBe(records[0].timeFrame!.serviceDate);
  });
  it("retains engine resolution separately from arithmetic-only observation replay", async () => {
    const departureUnix = query.departureTime.getTime() / 1000;
    vi.mocked(resolveDepartureOnDevice).mockResolvedValueOnce({serviceDate: "20261113", departureSecs: 28800, timeOriginUnix: departureUnix - 28800});
    vi.mocked(planOnDevice).mockResolvedValueOnce(itineraries);
    let record!: PipelineCapture;
    const output = await new SearchOrchestrator({...config(r => {record = r;}), stopPlanner: undefined}).search(query);
    expect(record.timeFrame).toEqual({kind: "engine", departureUnix, serviceDate: "20261113", departureSecs: 28800, timeOriginUnix: departureUnix - 28800});
    expect(await replaySearchPipeline(record)).toEqual(output);
    const changed = clone(record);changed.timeFrame!.timeOriginUnix++;
    await expect(replaySearchPipeline(changed)).rejects.toThrow("time origin");
  });
  it("records no planner invocation for empty reach while preserving direct walking", async () => {
    let record!: PipelineCapture;
    const options = {...config(r => {record = r;}), allStops: [], stopPlanner: vi.fn(async () => [])};
    const output = await new SearchOrchestrator(options).search(query);
    expect(options.stopPlanner).not.toHaveBeenCalled();expect(record.planner).toBeNull();
    expect(output).toHaveLength(1);expect(await replaySearchPipeline(record)).toEqual(output);
  });
  it("distinguishes a successful empty planner result from planner failure", async () => {
    let record!: PipelineCapture;
    const options = {...config(r => {record = r;}), directWalkRoute: undefined, stopPlanner: vi.fn(async () => [])};
    expect(await new SearchOrchestrator(options).search(query)).toEqual([]);
    expect(record.planner?.output).toEqual([]);expect(await replaySearchPipeline(record)).toEqual([]);
    const capture = vi.fn();
    await expect(new SearchOrchestrator({...config(capture), stopPlanner: async () => {throw new Error("planner failure");}}).search(query)).rejects.toThrow("planner failure");
    expect(capture).not.toHaveBeenCalled();
  });
  it("keeps overlapping searches isolated and snapshots planner arguments before await", async () => {
    const captures: PipelineCapture[] = [];
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const firstStarted = new Promise<void>(resolve => {started = resolve;});
    let calls = 0;
    const options = {...config(r => captures.push(r)), stopPlanner: async (q: Parameters<NonNullable<SearchConfig["stopPlanner"]>>[0]) => {
      if (++calls === 1) {started();await pending;} q.entryStops[0].walkSecs = 999;return [];
    }};
    const orchestrator = new SearchOrchestrator(options);
    const first = orchestrator.search(query);await firstStarted;
    const later = {...query, departureTime: new Date("2026-11-13T09:00:00+02:00")};
    await orchestrator.search(later);release();await first;
    expect(captures.map(r => r.query.departureTimeMs)).toEqual([later.departureTime.getTime(), query.departureTime.getTime()]);
    for (const r of captures) {expect(r.planner!.query.entryStops[0].walkSecs).toBe(0);expect(await replaySearchPipeline(r)).toEqual(r.output);}
  });
});
