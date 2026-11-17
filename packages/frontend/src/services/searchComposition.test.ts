import {it, expect, vi, afterEach} from "vitest";
import {composeSearchResults, replaySearchComposition, type CompositionInput, type CompositionCapture} from "./searchComposition.ts";
import {WalkGraphUnavailableError} from "./walkGraphAvailability.ts";

afterEach(() => vi.restoreAllMocks());
function input(): CompositionInput {
  return {itineraries: [{boardSecs: 100, alightSecs: 900, transfers: 1, legs: [
    {type: "transit", tripId: "T1", routeId: "R1", fromStopId: "A", toStopId: "B", departSecs: 100, arriveSecs: 300, boardStopIdx: 0, alightStopIdx: 1},
    {type: "walk", fromStopId: "B", toStopId: "C", departSecs: 300, arriveSecs: 420},
    {type: "transit", tripId: "T2", routeId: "R2", fromStopId: "C", toStopId: "D", departSecs: 600, arriveSecs: 900, boardStopIdx: 0, alightStopIdx: 1},
  ]}], entryWalks: [{stopId: "A", walkSecs: 0, distanceMeters: 0}], exitWalks: [{stopId: "D", walkSecs: 0, distanceMeters: 0}],
    departureSecs: 0, stops: [{id: "B", lat: 54, lon: 25}, {id: "C", lat: 54, lon: 25.001}],
    walkSpeedMps: 1.25, walking: null, ranking: "fastest", maxResults: 5, minTransferSecs: 120};
}
const route = (distanceMeters: number) => ({coords: [[25, 54], [25.001, 54]] as const, distanceMeters, steps: []});

it("captures physical transfer evidence before composition and frozen RT feasibility", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const provider = vi.fn(async () => ({...route(400), coords: [...route(400).coords]}));
  const delay = (id: string) => id === "T2" ? {delaySeconds: 120, cancelled: false, receivedAt: 1_000_000} : null;
  let record!: CompositionCapture;
  const output = await composeSearchResults(input(), provider, delay, () => 120, value => { record = value; });
  expect(provider).toHaveBeenCalledOnce();expect(output).toHaveLength(1);
  expect(output[0].totalWalkMeters).toBe(400);
  expect(output[0].legs[1]).toMatchObject({departSecs: 300, arriveSecs: 620, distanceMeters: 400});
  expect(record.input.itineraries[0].legs[1].arriveSecs).toBe(420);
  expect(record.reads[0]).toMatchObject({outcome: "route", route: {distanceMeters: 400}});
  clock.mockReturnValue(1_120_000);
  expect(await composeSearchResults(input(), provider, delay, () => 120)).toEqual([]);
  expect(JSON.stringify(await replaySearchComposition(JSON.parse(JSON.stringify(record))))).toBe(JSON.stringify(output));
  expect(provider).toHaveBeenCalledTimes(2); // Replay did not consult it.
  expect(Object.isFrozen(record.reads[0])).toBe(true);
});

it("distinguishes null-path evidence from typed graph unavailability", async () => {
  let noPath!: CompositionCapture, unavailable!: CompositionCapture;
  expect(await composeSearchResults(input(), async () => null, () => null, () => 120, r => { noPath = r; })).toEqual([]);
  const output = await composeSearchResults(input(), async () => {throw new WalkGraphUnavailableError("fixture", "transient");}, () => null, () => 120, r => { unavailable = r; });
  expect(output).toHaveLength(1);expect(output[0].totalWalkMeters).toBeUndefined();
  expect(unavailable.reads[0]).toMatchObject({outcome: "unavailable", cityId: "fixture", reason: "transient"});
  expect(await replaySearchComposition(noPath)).toEqual([]);
  expect(await replaySearchComposition(unavailable)).toEqual(unavailable.output);
});

it("preserves per-pair dedup and rejects changed geometry, arguments, extra reads or composition", async () => {
  const value = input();value.itineraries.push(structuredClone(value.itineraries[0]));
  const provider = vi.fn(async () => ({...route(100), coords: [...route(100).coords]}));
  let record!: CompositionCapture;
  await composeSearchResults(value, provider, () => null, () => 120, r => { record = r; });
  expect(record.reads).toHaveLength(1);expect(provider).toHaveBeenCalledOnce();
  expect((await replaySearchComposition(record))).toHaveLength(2);
  for (const mutate of [
    (r: CompositionCapture) => {if (r.reads[0].outcome === "route") r.reads[0].route!.distanceMeters = 400;},
    (r: CompositionCapture) => {r.reads[0].from.lat = 0;},
    (r: CompositionCapture) => {r.reads.push(r.reads[0]);},
    (r: CompositionCapture) => {r.finalization.input.composed[0].sourceWalkSecs = 30;},
    (r: CompositionCapture) => {r.output = [];},
  ]) {
    const bad = JSON.parse(JSON.stringify(record));mutate(bad);
    await expect(replaySearchComposition(bad)).rejects.toThrow(/changed|Composition/);
  }
});

it("empty planner outcomes avoid pedestrian calls and retain the explicit finalization observer", async () => {
  const value = input();value.itineraries = [];
  const provider = vi.fn(), finalization = vi.fn();let record!: CompositionCapture;
  expect(await composeSearchResults(value, provider, () => null, undefined, r => { record = r; }, finalization)).toEqual([]);
  expect(provider).not.toHaveBeenCalled();expect(finalization).toHaveBeenCalledOnce();
  expect(record.finalization).toEqual(finalization.mock.calls[0][0]);
  expect(await replaySearchComposition(record)).toEqual([]);
});

it("observes pedestrian arguments at invocation before asynchronous provider mutation", async () => {
  let record!: CompositionCapture;
  await composeSearchResults(input(), async from => {
    await Promise.resolve();from.lat = 0;
    return {...route(100), coords: [...route(100).coords]};
  }, () => null, () => 120, value => { record = value; });
  expect(record.reads[0].from.lat).toBe(54);
  expect(await replaySearchComposition(record)).toEqual(record.output);
});
