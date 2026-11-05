import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/index.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import type { PtRouterHandle } from "../../services/raptorWasm.ts";
import type { RaptorIndex } from "../../services/raptorIndex.ts";
import { WHEELCHAIR_WALK_SPEED_MPS } from "@pt/shared/constants";
import { prepareArriveBy } from "./arriveByQuery.ts";
import { ARRIVE_BY_MARKS } from "./arriveByMarks.ts";

vi.mock("../../services/osrmWasm.ts", () => ({
  osrmClient: { isReady: () => false, table: vi.fn(), init: vi.fn(async () => { throw new Error("no osrm"); }) },
}));

const ORIGIN = { kind: "stop" as const, stopId: "S1", name: "S1", lat: 54.68, lon: 25.28 };
const DEST = { kind: "mappoint" as const, lat: 54.7001, lon: 25.2801 };
const ORIGIN0 = Date.parse("2026-10-11T21:00:00Z") / 1000;
const router = {
  resolveTime: vi.fn(async (unix: number) => ({ serviceDate: "20261012", timeOriginUnix: ORIGIN0, departureSecs: unix - ORIGIN0 })),
} as unknown as PtRouterHandle;

beforeEach(async () => {
  await db.gtfsStops.clear();
  await db.gtfsStops.bulkAdd([
    { id: "S1", name: "First", lat: 54.68, lon: 25.28 },
    { id: "S3", name: "Third", lat: 54.70, lon: 25.28 },
  ]);
  useGtfsDataStore.setState({ raptorIndex: { footTransfers: undefined } as unknown as RaptorIndex });
  useCityStore.setState({ activeCity: { ...useCityStore.getState().activeCity, tz: "Europe/Vilnius" } });
  useSettingsStore.setState({ excludedModes: ["FERRY", "TRAM"], mobilityProfile: "default", runToCatch: false });
  vi.mocked(router.resolveTime).mockClear();
});

describe("prepareArriveBy", () => {
  it("builds the early-4h scope for the deadline from the planner's stops and settings", async () => {
    const deadline = Date.parse("2026-10-12T10:00:00+03:00");
    const result = await prepareArriveBy(ORIGIN, DEST, deadline, router);
    expect(router.resolveTime).toHaveBeenCalledWith(deadline / 1000 - 4 * 3600);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    const { input, stops, origin, destination } = result.prepared;
    expect(input.scope).toMatchObject({ serviceDate: 20261012, windowStart: 21600, windowEnd: 36001, arrivalDeadline: 36000, maxRounds: 4 });
    expect(input.scope.entryStops).toEqual([{ stopId: "S1", walkSecs: 0 }]);
    expect(input.scope.exitStops.map((s) => s.stopId)).toEqual(["S3"]);
    expect(input.excludedModes).toEqual([4, 0]);
    expect(input.mobilityProfile).toBe("default");
    expect(input.walkSpeedMps).toBe(useSettingsStore.getState().walkSpeedMps);
    expect(input.minTransferSecs).toBe(120);
    expect(stops.get("S1")?.name).toBe("First");
    expect(origin).toEqual({ lat: 54.68, lon: 25.28 });
    expect(destination).toEqual({ lat: 54.7001, lon: 25.2801 });
  });

  it("maps profiles the engine lacks to its default and keeps wheelchair", async () => {
    useSettingsStore.setState({ mobilityProfile: "vision_impaired" });
    const a = await prepareArriveBy(ORIGIN, DEST, Date.parse("2026-10-12T10:00:00+03:00"), router);
    useSettingsStore.setState({ mobilityProfile: "wheelchair" });
    const b = await prepareArriveBy(ORIGIN, DEST, Date.parse("2026-10-12T10:00:00+03:00"), router);
    expect(a.kind === "ready" && a.prepared.input.mobilityProfile).toBe("default");
    expect(b.kind === "ready" && b.prepared.input.mobilityProfile).toBe("wheelchair");
  });

  it("sends the rider's own walk speed, the wheelchair speed for a wheelchair rider", async () => {
    useSettingsStore.setState({ mobilityProfile: "vision_impaired", walkSpeedMps: 0.9 });
    const a = await prepareArriveBy(ORIGIN, DEST, Date.parse("2026-10-12T10:00:00+03:00"), router);
    useSettingsStore.setState({ mobilityProfile: "wheelchair", walkSpeedMps: 1.4 });
    const b = await prepareArriveBy(ORIGIN, DEST, Date.parse("2026-10-12T10:00:00+03:00"), router);
    expect(a.kind === "ready" && a.prepared.input.walkSpeedMps).toBe(0.9);
    expect(b.kind === "ready" && b.prepared.input.walkSpeedMps).toBe(WHEELCHAIR_WALK_SPEED_MPS);
  });

  it("marks the end of each step for its caller (H73)", async () => {
    performance.clearMarks();
    await prepareArriveBy(ORIGIN, DEST, Date.parse("2026-10-12T10:00:00+03:00"), router, "results");
    const marks = performance.getEntriesByName(ARRIVE_BY_MARKS.prepared) as PerformanceMark[];
    expect(marks).toHaveLength(1);
    const d = marks[0]!.detail as Record<string, number | string>;
    expect(d).toMatchObject({ caller: "results", stops: 2 });
    const times = [d.start, d.stopsRead, d.reachable, d.resolveTime, d.lookup, marks[0]!.startTime] as number[];
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("reports endpoints with no reachable stop and does not resolve the time", async () => {
    const far = { kind: "mappoint" as const, lat: 55.5, lon: 26.5 };
    expect(await prepareArriveBy(ORIGIN, far, Date.now(), router)).toEqual({ kind: "no-stops" });
    expect(router.resolveTime).not.toHaveBeenCalled();
  });
});
