import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { GbfsSystemRow, GbfsStationInfoRow } from "./index.ts";

function makeStations(): GbfsStationInfoRow[] {
  return [
    {
      station_id: "42",
      name: "Katedros aikštė",
      lat: 54.685,
      lon: 25.287,
      address: "Šventaragio g.",
      capacity: 20,
    },
    // Optional fields absent — must round-trip as absent, not null.
    { station_id: "43", name: "Rotušės aikštė", lat: 54.678, lon: 25.286 },
  ];
}

describe("gbfsSystems table", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
  });

  afterEach(async () => {
    const mod = await import("./index.ts");
    mod.db.close();
    await Dexie.delete("ptn");
  });

  it("opens with gbfsSystems present", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    expect(db.verno).toBe(7);
    expect(db.gbfsSystems).toBeDefined();
    expect(await db.gbfsSystems.count()).toBe(0);
  });

  it("round-trips a system row through write/read helpers", async () => {
    const { db, readGbfsSystem, writeGbfsSystem } = await import("./index.ts");
    await db.open();
    const stations = makeStations();
    await writeGbfsSystem("vilnius", "cyclocity", stations, 1_700_000_000_000);

    const back = await readGbfsSystem("vilnius", "cyclocity");
    expect(back).toBeDefined();
    expect(back?.key).toBe("vilnius:cyclocity");
    expect(back?.fetchedAt).toBe(1_700_000_000_000);
    expect(back?.stations).toEqual(stations);
    // Optional fields stay absent after the structured-clone round-trip.
    expect("address" in (back?.stations[1] ?? {})).toBe(false);
    expect("capacity" in (back?.stations[1] ?? {})).toBe(false);
  });

  it("returns undefined for a system that was never written", async () => {
    const { db, readGbfsSystem } = await import("./index.ts");
    await db.open();
    expect(await readGbfsSystem("vilnius", "cyclocity")).toBeUndefined();
  });

  it("scopes rows by composite key — same system id in another city is separate", async () => {
    const { db, readGbfsSystem, writeGbfsSystem } = await import("./index.ts");
    await db.open();
    await writeGbfsSystem("vilnius", "cyclocity", makeStations(), 1);
    await writeGbfsSystem("paris", "cyclocity", [], 2);

    expect(await db.gbfsSystems.count()).toBe(2);
    expect((await readGbfsSystem("vilnius", "cyclocity"))?.stations).toHaveLength(2);
    expect((await readGbfsSystem("paris", "cyclocity"))?.stations).toHaveLength(0);
  });

  it("overwrites on repeated write for the same city+system", async () => {
    const { db, readGbfsSystem, writeGbfsSystem } = await import("./index.ts");
    await db.open();
    await writeGbfsSystem("vilnius", "cyclocity", makeStations(), 1);
    const fresh: GbfsSystemRow["stations"] = [
      { station_id: "99", name: "Naujas", lat: 54.7, lon: 25.3 },
    ];
    await writeGbfsSystem("vilnius", "cyclocity", fresh, 2);

    expect(await db.gbfsSystems.count()).toBe(1);
    const back = await readGbfsSystem("vilnius", "cyclocity");
    expect(back?.fetchedAt).toBe(2);
    expect(back?.stations).toEqual(fresh);
  });

  it("keeps prior tables intact in the v17 store map (spot check)", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    // v16's scheduleTileCache and the earliest tables still exist alongside
    // the new table — the v17 map is purely additive.
    const names = new Set(db.tables.map((t) => t.name));
    expect(names.has("gbfsSystems")).toBe(true);
    expect(names.has("scheduleTileCache")).toBe(true);
    expect(names.has("stops")).toBe(true);
    expect(names.has("ptbBytes")).toBe(true);
  });
});
