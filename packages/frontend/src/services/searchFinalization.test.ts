import {afterEach, expect, it, vi} from "vitest";
import {finalizeSearch, replayFinalization, type FinalizationInput, type FinalizationCapture} from "./searchFinalization.ts";
import type {RtComposedItinerary} from "./rtOverlay.ts";

afterEach(() => vi.restoreAllMocks());
function candidate(): RtComposedItinerary {
  return {sourceWalkSecs: 500, destWalkSecs: 0, departureSecs: 0, arrivalSecs: 900,
    totalSecs: 900, transfers: 0, totalWalkSecs: 500, totalWalkMeters: 1214,
    legs: [{type: "transit", tripId: "T", routeId: "R", fromStopId: "A", toStopId: "B",
      departSecs: 420, arriveSecs: 900, boardStopIdx: 1, alightStopIdx: 2}]};
}
const input = (): FinalizationInput => ({composed: [candidate()], walking: null, ranking: "fastest", maxResults: 5, minTransferSecs: 120});

it("replays observed fresh RT after the live clock would make it stale", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const delay = () => ({delaySeconds: 180, cancelled: false, receivedAt: 1_000_000});
  let capture!: FinalizationCapture;
  const output = finalizeSearch(input(), delay, undefined, record => { capture = record; });
  expect(output).toHaveLength(1);expect(output[0].legs[0].departSecs).toBe(600);
  clock.mockReturnValue(1_120_000);
  expect(finalizeSearch(input(), delay)).toEqual([]); // The unfrozen control is now stale and cannot board.
  expect(JSON.stringify(replayFinalization(JSON.parse(JSON.stringify(capture))))).toBe(JSON.stringify(output));
  expect(capture.input.composed[0].totalWalkMeters).toBe(1214);
  expect(capture.classification).toBe("partial capture");
});

it("captures every RT read rather than guessing one final value per trip", () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const delay = vi.fn().mockReturnValueOnce({delaySeconds: 0, cancelled: false})
    .mockReturnValue({delaySeconds: 180, cancelled: false});
  let record!: FinalizationCapture;
  const output = finalizeSearch(input(), delay, undefined, value => { record = value; });
  expect(record.reads).toHaveLength(2);
  expect(record.reads[0]).toMatchObject({kind: "delay", value: {delaySeconds: 0}});
  expect(record.reads[1]).toMatchObject({kind: "delay", value: {delaySeconds: 180}});
  expect(replayFinalization(record)).toEqual(output);
});

it("retains routed direct-walk geometry and ranks it after RT feasibility", () => {
  const value = input();
  value.walking = {sourceWalkSecs: 0, destWalkSecs: 0, departureSecs: 0, arrivalSecs: 12, totalSecs: 12,
    totalWalkSecs: 12, totalWalkMeters: 15, transfers: 0, legs: [],
    directWalk: {origin: {lat: 54, lon: 25}, destination: {lat: 54, lon: 25.0002},
      route: {coords: [[25, 54], [25.0002, 54]], distanceMeters: 15, steps: []}}};
  let record!: FinalizationCapture;
  const output = finalizeSearch(value, () => null, undefined, r => { record = r; });
  expect(output).toEqual([value.walking]);
  value.walking.directWalk!.route.coords[0] = [0, 54];
  expect(record.input.walking!.directWalk!.route.coords[0][0]).toBe(25);
  expect(Object.isFrozen(record.input.walking!.directWalk!.route.coords)).toBe(true);
  expect(replayFinalization(record)).toEqual(record.output);
});

it("replays transfer floor arguments and rejects missing reordered or unused lookup evidence", () => {
  const value = input(), first = value.composed[0];first.sourceWalkSecs = 0;
  const leg = first.legs[0];if (leg.type !== "transit") throw new Error("transit fixture");
  first.legs.push({...leg, tripId: "U", fromStopId: "B", toStopId: "C", departSecs: 1200, arriveSecs: 1500});
  first.transfers = 1;
  let record!: FinalizationCapture;
  finalizeSearch(value, () => null, () => 120, r => { record = r; });
  expect(record.reads.some(r => r.kind === "floor")).toBe(true);
  expect(replayFinalization(record)).toEqual(record.output);
  for (const mutate of [
    (r: FinalizationCapture) => { r.reads.shift(); },
    (r: FinalizationCapture) => { r.reads.reverse(); },
    (r: FinalizationCapture) => { r.reads.push(r.reads[0]); },
    (r: FinalizationCapture) => { r.output = []; },
  ]) {
    const bad = JSON.parse(JSON.stringify(record));mutate(bad);
    expect(() => replayFinalization(bad)).toThrow(/Finalization|finalization/);
  }
});

it("does not capture by default and refuses non-finite or oversized requested evidence", () => {
  expect(finalizeSearch(input(), () => null)).toEqual([]);
  expect(() => finalizeSearch(input(), () => ({delaySeconds: NaN, cancelled: false}), undefined, () => {})).toThrow(/finite/);
  const large = input();large.composed[0].legs[0].fromStopId = "x".repeat(2 * 1024 * 1024);
  expect(() => finalizeSearch(large, () => null, undefined, () => {})).toThrow(/limit/);
});
