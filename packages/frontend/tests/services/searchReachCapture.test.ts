import {describe, it, expect, vi} from "vitest";
import {captureReachableStops, replayReachableStops, type ReachCapture} from "../../src/services/searchReachCapture.ts";
const origin = {lat: 54.68, lon: 25.28};
const stops = [{id: "a", name: "A", ...origin}, {id: "b", name: "B", lat: 54.681, lon: 25.28}];
const options = {maxWalkSecs: 300, walkSpeedMps: 1.25, radiusMeters: 500};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
describe("directed reach observation", () => {
  it.each(["origin", "destination"] as const)("replays %s directed table, frozen and independent of live providers", async role => {
    let record!: ReachCapture;
    const table = vi.fn(async () => role === "origin" ? {durations: [[10, -1]]} : {durations: [[-1], [20]]});
    const output = await captureReachableStops(origin, stops, {...options, role}, {isReady: () => true, table}, "default", r => {record = r;});
    expect(table).toHaveBeenCalledWith(role === "origin" ? [origin] : stops.map(s => ({lat: s.lat, lon: s.lon})), role === "origin" ? stops.map(s => ({lat: s.lat, lon: s.lon})) : [origin]);
    expect(output.map(s => s.stopId)).toEqual([role === "origin" ? "a" : "b"]);
    expect(Object.isFrozen(record.reads)).toBe(true);
    expect(await replayReachableStops(record)).toEqual(output);
    expect(table).toHaveBeenCalledTimes(1);
    const changed = copy(record);
    changed.input.options.role = role === "origin" ? "destination" : "origin";
    await expect(replayReachableStops(changed)).rejects.toThrow("arguments changed");
  });
  it("retains directed fallback misses and repeated transfer reads, including running and forced opaque IDs", async () => {
    let record!: ReachCapture;
    const lookup = vi.fn((from: string, to: string) => from === "b" && to === "end" ? 100 : undefined);
    const output = await captureReachableStops(origin, stops, {...options, role: "destination", destStopId: "end", destStopIds: ["opaque"], runToCatch: true, osmLookup: {getWalkSecs: lookup}}, {isReady: () => false, table: vi.fn()}, "default", r => {record = r;});
    expect(record.reads.filter(r => r.kind === "transfer")).toHaveLength(4);
    expect(record.reads).toContainEqual({kind: "transfer", from: "a", to: "end", value: null});
    expect(output[0]).toEqual({stopId: "a", walkSecs: 0, distanceMeters: 0});
    expect(output.some(r => r.stopId === "opaque" && r.walkSecs === 0)).toBe(true);
    expect(await replayReachableStops(record)).toEqual(output);
    const changed = copy(record); changed.reads.push(copy(changed.reads[0]));
    await expect(replayReachableStops(changed)).rejects.toThrow("count changed");
  });
  it("records ready-but-null fallback and wheelchair running suppression", async () => {
    let record!: ReachCapture;
    await captureReachableStops(origin, stops, {...options, runToCatch: true}, {isReady: () => true, table: async () => null}, "wheelchair", r => {record = r;});
    expect(record.reads.map(r => r.kind)).toEqual(["ready", "table"]);
    expect(record.output.every(r => !r.runToCatch)).toBe(true);
    expect(await replayReachableStops(record)).toEqual(record.output);
    const changed = copy(record);changed.output.reverse();
    await expect(replayReachableStops(changed)).rejects.toThrow("output");
  });
  it("does not emit successful evidence on provider failure", async () => {
    const capture = vi.fn();
    await expect(captureReachableStops(origin, stops, options, {isReady: () => true, table: async () => {throw new Error("worker failed");}}, "default", capture)).rejects.toThrow("worker failed");
    expect(capture).not.toHaveBeenCalled();
  });
  it("snapshots table arguments before awaiting a mutating provider", async () => {
    let record!: ReachCapture;
    const local = {...origin};
    await captureReachableStops(local, stops, options, {isReady: () => true, table: async (sources) => {sources[0].lat = 0; return {durations: [[10, 20]]};}}, "default", r => {record = r;});
    expect(record.input.origin).toEqual(origin);
    expect(record.reads[1]).toMatchObject({sources: [origin]});
    expect(await replayReachableStops(record)).toEqual(record.output);
  });
  it("keeps capture disabled by default and rejects non-finite observations", async () => {
    const provider = {isReady: () => true, table: async () => ({durations: [[NaN, -1]]})};
    await expect(captureReachableStops(origin, stops, options, provider, "default", () => {})).rejects.toThrow("finite JSON");
    await expect(captureReachableStops(origin, stops, options, {isReady: () => false, table: vi.fn()})).resolves.toHaveLength(2);
  });
});
