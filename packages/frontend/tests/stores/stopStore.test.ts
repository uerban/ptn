import { describe, it, expect, beforeEach, vi } from "vitest";
import { useStopStore } from "../../src/stores/stopStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { db } from "../../src/db/index.ts";
import { usePrivacyChoicesStore } from "../../src/stores/privacyChoicesStore.ts";
import {
  PRIVACY_DATA_MIGRATION_KEY,
  PRIVACY_DATA_MIGRATION_VERSION,
} from "../../src/services/privacyDataMigrationState.ts";

describe("StopStore", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    useStopStore.getState().reset();
    localStorage.setItem(
      PRIVACY_DATA_MIGRATION_KEY,
      PRIVACY_DATA_MIGRATION_VERSION,
    );
    usePrivacyChoicesStore
      .getState()
      .setChoice("personalization", "enabled");
  });

  it("adds stops and persists to Dexie", async () => {
    await useStopStore.getState().upsertStops([
      {
        id: "s1",
        name: "Stop 1",
        location: { lat: 54.68, lon: 25.28 },
        routes: [{ id: "r1", shortName: "1", color: "0073AC", mode: "BUS" }],
      },
    ]);
    expect(useStopStore.getState().stops).toHaveLength(1);
    const persisted = await db.stops.get("s1");
    expect(persisted?.name).toBe("Stop 1");
  });

  it("maps and persists the precomputed labelAnchor", async () => {
    await useStopStore.getState().upsertStops([
      {
        id: "s1",
        name: "Stop 1",
        location: { lat: 54.68, lon: 25.28 },
        labelAnchor: "top-left",
      },
    ]);
    expect(useStopStore.getState().stops[0].labelAnchor).toBe("top-left");
    expect((await db.stops.get("s1"))?.labelAnchor).toBe("top-left");
  });

  it("hydrates from Dexie", async () => {
    await db.stops.put({
      id: "s2",
      name: "Cached Stop",
      location: { lat: 54.69, lon: 25.29 },
      lastSeen: Date.now(),
    });
    await useStopStore.getState().hydrate();
    expect(useStopStore.getState().stops.find((s) => s.id === "s2")).toBeDefined();
  });

  it("records usage stats", async () => {
    const store = useStopStore.getState();
    await store.recordTap("s1");
    await store.recordTap("s1");
    const stat = await db.usageStats.get("s1");
    expect(stat?.tapCount).toBe(2);
  });

  it("does not record usage stats before opt-in", async () => {
    usePrivacyChoicesStore
      .getState()
      .setChoice("personalization", "unset");
    await useStopStore.getState().recordTap("s1");
    expect(await db.usageStats.count()).toBe(0);
  });

  it("computes preload priority score", async () => {
    const store = useStopStore.getState();
    await store.recordTap("s1");
    await store.recordTap("s1");
    await store.recordTap("s1");
    const score = await store.getPreloadScore("s1");
    // tapCount(3) * 3 + recencyBonus(10) = 19
    expect(score).toBe(19);
  });

  it("preserves stops array reference when upserting identical data", async () => {
    const stopData = [
      {
        id: "s1",
        name: "Stop 1",
        location: { lat: 54.68, lon: 25.28 },
        routes: [{ id: "r1", shortName: "1", color: "0073AC", mode: "BUS" as const }],
      },
      {
        id: "s2",
        name: "Stop 2",
        location: { lat: 54.69, lon: 25.29 },
        routes: [{ id: "r2", shortName: "2", color: "FF0000", mode: "TRAM" as const }],
      },
    ];

    await useStopStore.getState().upsertStops(stopData);
    const refAfterFirst = useStopStore.getState().stops;

    await useStopStore.getState().upsertStops(stopData);
    const refAfterSecond = useStopStore.getState().stops;

    expect(refAfterSecond).toBe(refAfterFirst);
  });

  it("updates stops array reference when upserting modified data", async () => {
    const stopData = [
      {
        id: "s1",
        name: "Stop 1",
        location: { lat: 54.68, lon: 25.28 },
        routes: [{ id: "r1", shortName: "1", color: "0073AC", mode: "BUS" as const }],
      },
    ];

    await useStopStore.getState().upsertStops(stopData);
    const refAfterFirst = useStopStore.getState().stops;

    const modifiedData = [
      {
        id: "s1",
        name: "Stop 1 Renamed",
        location: { lat: 54.68, lon: 25.28 },
        routes: [{ id: "r1", shortName: "1", color: "0073AC", mode: "BUS" as const }],
      },
    ];

    await useStopStore.getState().upsertStops(modifiedData);
    const refAfterSecond = useStopStore.getState().stops;

    expect(refAfterSecond).not.toBe(refAfterFirst);
    expect(refAfterSecond[0].name).toBe("Stop 1 Renamed");
  });

  it("persists line data to IndexedDB and restores on hydrate", async () => {
    await useStopStore.getState().upsertStops([{
      id: "s1",
      name: "Test Stop",
      location: { lat: 54.68, lon: 25.28 },
      routes: [{ id: "r1", shortName: "3G", color: "#e63946", mode: "BUS" }],
    }]);

    // Verify lines are in memory
    const inMemory = useStopStore.getState().stops;
    expect(inMemory[0].lines).toHaveLength(1);
    expect(inMemory[0].lines![0].shortName).toBe("3G");

    // Verify lines are persisted to DB
    const persisted = await db.stops.get("s1");
    expect(persisted?.lines).toHaveLength(1);
    expect(persisted?.lines![0].shortName).toBe("3G");

    // Reset in-memory state and hydrate from DB
    useStopStore.setState({ stops: [], hydrated: false });
    await useStopStore.getState().hydrate();

    // Verify lines survived the round-trip
    const hydrated = useStopStore.getState().stops;
    expect(hydrated[0].lines).toHaveLength(1);
    expect(hydrated[0].lines![0].shortName).toBe("3G");
  });

  it("updates reference when line content changes but count stays the same", async () => {
    const stopData = [
      {
        id: "s1",
        name: "Stop 1",
        location: { lat: 54.68, lon: 25.28 },
        routes: [{ id: "r1", shortName: "1", color: "0073AC", mode: "BUS" as const }],
      },
    ];

    await useStopStore.getState().upsertStops(stopData);
    const refAfterFirst = useStopStore.getState().stops;

    const modifiedData = [
      {
        id: "s1",
        name: "Stop 1",
        location: { lat: 54.68, lon: 25.28 },
        routes: [{ id: "r1", shortName: "1", color: "FF0000", mode: "BUS" as const }],
      },
    ];

    await useStopStore.getState().upsertStops(modifiedData);
    const refAfterSecond = useStopStore.getState().stops;

    expect(refAfterSecond).not.toBe(refAfterFirst);
    expect(refAfterSecond[0].lines?.[0].color).toBe("FF0000");
  });

  // IDB persistence is best-effort. iOS PWAs with near-quota storage have
  // been observed to throw on bulkPut of the multi-MB /stops/all payload
  // while accepting the much smaller /stops/nearby payload — leaving the
  // map showing only the nearby subset and no recovery path short of a
  // reinstall (see fix/pwa-stops-cache-poison). The fix decouples the
  // in-memory render path from the persist path.
  it("updates in-memory stops even when bulkPut throws (best-effort persist)", async () => {
    const bulkPutSpy = vi
      .spyOn(db.stops, "bulkPut")
      .mockRejectedValueOnce(new Error("QuotaExceededError"));

    await useStopStore.getState().upsertStops([
      {
        id: "s1",
        name: "Stop 1",
        location: { lat: 54.68, lon: 25.28 },
        routes: [{ id: "r1", shortName: "1", color: "0073AC", mode: "BUS" }],
      },
    ]);

    expect(useStopStore.getState().stops).toHaveLength(1);
    expect(useStopStore.getState().stops[0].name).toBe("Stop 1");
    expect(bulkPutSpy).toHaveBeenCalledTimes(1);

    bulkPutSpy.mockRestore();
  });

  // City-switch leak: an in-flight upsert for city A must not land into
  // city B's store after reset() has run. The store re-checks isStale()
  // after its internal awaits (clearingDb, bulkPut) and reverts via reset()
  // if it discovers it's stale, so the cleared state isn't re-poisoned.
  it("does not write stale upsert when isStale() flips during the call", async () => {
    let stale = false;
    const isStale = () => stale;

    // Start an upsert, flip stale partway through (simulating a city switch
    // during the bulkPut await), and confirm the store ends up empty rather
    // than holding the upserted records.
    const upsertPromise = useStopStore.getState().upsertStops(
      [{
        id: "s1", name: "Stop 1",
        location: { lat: 54.68, lon: 25.28 },
        routes: [{ id: "r1", shortName: "1", color: "0073AC", mode: "BUS" }],
      }],
      { isStale },
    );

    // Flip stale before the await chain in upsertStops settles
    stale = true;
    await upsertPromise;

    // Either the upsert short-circuited before set() OR it ran set() then
    // reverted via reset(). Either way: no leaked records.
    expect(useStopStore.getState().stops).toHaveLength(0);
  });

  it("hydrate keeps stale stops on the map but drops their stale badge lines", async () => {
    const now = Date.now();
    const STALE = now - (25 * 60 * 60 * 1000); // 25h ago — over the 24h window
    const FRESH = now - (60 * 1000);           // 1 min ago

    await db.stops.put({
      id: "stale",
      name: "Stale Stop",
      location: { lat: 1, lon: 1 },
      lastSeen: STALE,
      lines: [{ routeId: "r-old", shortName: "OLD", mode: "BUS" }],
    });
    await db.stops.put({
      id: "fresh",
      name: "Fresh Stop",
      location: { lat: 2, lon: 2 },
      lastSeen: FRESH,
      lines: [{ routeId: "r-new", shortName: "NEW", mode: "BUS" }],
    });

    await useStopStore.getState().hydrate();

    const byId = new Map(useStopStore.getState().stops.map((s) => [s.id, s]));
    // Geometry survives: a stop the server cannot currently confirm is still
    // a real stop, and blanking the map is worse than a name-only card.
    expect(byId.get("stale")?.name).toBe("Stale Stop");
    expect(byId.get("stale")?.location).toEqual({ lat: 1, lon: 1 });
    // ...but its badge lines are dropped — that is what the TTL is for.
    expect(byId.get("stale")?.lines ?? []).toEqual([]);
    // Fresh rows are untouched.
    expect(byId.get("fresh")?.lines).toHaveLength(1);

    // Neither row is deleted: db.stops is the offline floor for the map when
    // /stops/all is unreachable.
    expect(await db.stops.get("stale")).toBeDefined();
    expect(await db.stops.get("fresh")).toBeDefined();
  });

  describe("PTB bundle fallback", () => {
    async function seedBundle(cityId: string) {
      await db.gtfsSyncMeta.put({
        id: "current",
        cityId,
        etag: "e1",
        lastSynced: Date.now(),
        generatedAt: "2026-09-20T00:00:00Z",
        generationId: "g1",
      });
      await db.gtfsStops.bulkPut([
        { id: "b1", name: "Bundle One", lat: 54.1, lon: 25.1 },
        { id: "b2", name: "Bundle Two", lat: 54.2, lon: 25.2 },
      ]);
      await db.gtfsRoutes.bulkPut([
        {
          id: "r1",
          shortName: "3G",
          mode: "BUS",
          color: "0073AC",
          stopIds: ["b1", "b2"],
        },
        {
          id: "r2",
          shortName: "11",
          mode: "TRAM",
          stopIds: ["b2"],
        },
      ]);
    }

    it("renders the bundle's stops when the server snapshot is empty", async () => {
      await seedBundle(useCityStore.getState().activeCity.id);

      await useStopStore.getState().hydrate();

      const byId = new Map(useStopStore.getState().stops.map((s) => [s.id, s]));
      expect(byId.get("b1")?.name).toBe("Bundle One");
      expect(byId.get("b1")?.location).toEqual({ lat: 54.1, lon: 25.1 });
      expect(byId.size).toBe(2);
    });

    it("derives badge lines from the bundle's own route membership", async () => {
      await seedBundle(useCityStore.getState().activeCity.id);

      await useStopStore.getState().hydrate();

      const byId = new Map(useStopStore.getState().stops.map((s) => [s.id, s]));
      expect(byId.get("b1")?.lines).toEqual([
        { routeId: "r1", shortName: "3G", color: "0073AC", mode: "BUS" },
      ]);
      expect(byId.get("b2")?.lines?.map((l) => l.routeId)).toEqual(["r1", "r2"]);
    });

    it("re-lines a stale server row from the bundle instead of leaving it bare", async () => {
      await seedBundle(useCityStore.getState().activeCity.id);
      await db.stops.put({
        id: "b1",
        name: "Server One",
        location: { lat: 54.1, lon: 25.1 },
        lastSeen: Date.now() - (25 * 60 * 60 * 1000),
        lines: [{ routeId: "r-old", shortName: "OLD", mode: "BUS" }],
      });

      await useStopStore.getState().hydrate();

      const b1 = useStopStore.getState().stops.find((s) => s.id === "b1");
      // The server's own name wins (it is the display source of truth), but the
      // stale badge comes back from the bundle the planner is already using.
      expect(b1?.name).toBe("Server One");
      expect(b1?.lines?.map((l) => l.shortName)).toEqual(["3G"]);
    });

    it("ignores bundle stops belonging to another city", async () => {
      await seedBundle("some-other-city");

      await useStopStore.getState().hydrate();

      expect(useStopStore.getState().stops).toHaveLength(0);
    });

    it("leaves a fresh server snapshot alone", async () => {
      await seedBundle(useCityStore.getState().activeCity.id);
      await db.stops.put({
        id: "s-fresh",
        name: "Server Fresh",
        location: { lat: 3, lon: 3 },
        lastSeen: Date.now(),
        lines: [{ routeId: "r-server", shortName: "SRV", mode: "BUS" }],
      });

      await useStopStore.getState().hydrate();

      const stops = useStopStore.getState().stops;
      expect(stops).toHaveLength(1);
      expect(stops[0].lines?.[0].shortName).toBe("SRV");
    });

    it("overlays the bundle on demand when a live /stops/all fetch gives up", async () => {
      await seedBundle(useCityStore.getState().activeCity.id);
      await useStopStore.getState().hydrate();
      // Simulate the session having started with a usable server snapshot that
      // was then wiped (city switch, schema bump) while the server is down.
      useStopStore.setState({ stops: [] });

      await useStopStore.getState().overlayBundleStops();

      expect(useStopStore.getState().stops.map((s) => s.id).sort()).toEqual(["b1", "b2"]);
    });
  });
});
