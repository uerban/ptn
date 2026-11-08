import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { db } from "../db/index.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useDownloadedStops } from "./useDownloadedStops.ts";

async function seed(cityId: string) {
  await db.gtfsStops.put({ id: "s1", name: "Central", lat: 54.1, lon: 25.2 });
  await db.gtfsSyncMeta.put({
    id: "current",
    cityId,
    etag: '"seed"',
    generationId: "s".repeat(64),
    lastSynced: 1234,
    generatedAt: "2026-01-01",
  });
}

beforeEach(async () => {
  await db.gtfsStops.clear();
  await db.gtfsSyncMeta.clear();
});
afterEach(async () => {
  await db.gtfsStops.clear();
  await db.gtfsSyncMeta.clear();
});

describe("useDownloadedStops", () => {
  it("returns the active city's downloaded stops", async () => {
    await seed(useCityStore.getState().activeCity.id);
    const { result } = renderHook(() => useDownloadedStops());
    await waitFor(() =>
      expect(result.current).toEqual([
        { id: "s1", name: "Central", location: { lat: 54.1, lon: 25.2 }, lastSeen: 1234 },
      ]),
    );
  });

  it("is empty while the stored timetable belongs to another city", async () => {
    await seed("elsewhere");
    const { result } = renderHook(() => useDownloadedStops());
    // Give the live query a chance to resolve before asserting it stays empty.
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current).toEqual([]);
  });
});
