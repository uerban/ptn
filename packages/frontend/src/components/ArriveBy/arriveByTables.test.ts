import { seedLegacyCityProjection } from "../../test-helpers/cityData.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/index.ts";
import type { RaptorIndex } from "../../services/raptorIndex.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { arriveByRouteColors, arriveByStopTable } from "./arriveByTables.ts";

const realGeneration = useGtfsDataStore.getState().getInitGeneration;
const newIndex = (): void => { useGtfsDataStore.setState({ raptorIndex: {} as unknown as RaptorIndex, syncing: false }); };

beforeEach(async () => {
  await db.gtfsStops.clear();
  await db.gtfsRoutes.clear();
  await seedLegacyCityProjection();
  await db.gtfsStops.bulkAdd([{ id: "S1", name: "First", lat: 54.68, lon: 25.28 }]);
  await db.gtfsRoutes.bulkAdd([
    { id: "R1", shortName: "1", mode: "BUS", color: "#ff0000", stopIds: [] },
    { id: "R2", shortName: "2", mode: "BUS", stopIds: [] },
  ] as never);
  newIndex();
});
afterEach(() => {
  useGtfsDataStore.setState({ getInitGeneration: realGeneration, syncing: false });
  vi.restoreAllMocks();
});

describe("arrive-by kept tables (H73 step 2)", () => {
  it("reads each table once per index and returns the rows a fresh read returns", async () => {
    const stopsRead = vi.spyOn(db.gtfsStops, "toArray");
    const routesRead = vi.spyOn(db.gtfsRoutes, "toArray");
    const a = await arriveByStopTable(), b = await arriveByStopTable();
    expect(b).toBe(a);
    expect(a.rows).toEqual(await db.gtfsStops.toArray());
    expect(a.lookup.get("S1")).toEqual({ name: "First", lat: 54.68, lon: 25.28 });
    expect(stopsRead).toHaveBeenCalledTimes(2);
    expect([...(await arriveByRouteColors())]).toEqual([["R1", "#ff0000"]]);
    await arriveByRouteColors();
    expect(routesRead).toHaveBeenCalledTimes(1);
  });

  it("reads again for a new index or a new init generation", async () => {
    const first = await arriveByStopTable();
    newIndex();
    const second = await arriveByStopTable();
    expect(second).not.toBe(first);
    useGtfsDataStore.setState({ getInitGeneration: () => realGeneration() + 1 });
    const third = await arriveByStopTable();
    expect(third).not.toBe(second);
    expect(await arriveByStopTable()).toBe(third);
  });

  it("keeps nothing read while a sync runs, and drops what it kept", async () => {
    const before = await arriveByStopTable();
    useGtfsDataStore.setState({ syncing: true });
    await db.gtfsStops.put({ id: "S2", name: "Second", lat: 54.7, lon: 25.3 });
    const during = await arriveByStopTable();
    expect(during).not.toBe(before);
    expect(during.rows).toHaveLength(2);
    expect(await arriveByStopTable()).not.toBe(during);
    useGtfsDataStore.setState({ syncing: false });
    const after = await arriveByStopTable();
    expect(after).not.toBe(before);
    expect(after.rows).toHaveLength(2);
  });

  it("does not keep a failed read", async () => {
    vi.spyOn(db.gtfsRoutes, "toArray").mockRejectedValueOnce(new Error("idb"));
    await expect(arriveByRouteColors()).rejects.toThrow("idb");
    expect([...(await arriveByRouteColors())]).toEqual([["R1", "#ff0000"]]);
  });
});
