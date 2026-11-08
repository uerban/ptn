import {expect, test} from "@playwright/test";
import {mockApiAtServiceTime} from "../helpers/mock-api";

test("legacy download restores geometry after an API-offline reload without table projection @mock-api", async ({page}) => {
  test.setTimeout(45_000);
  const vite = await page.request.get("/@vite/client");
  test.skip(!vite.ok() || !(await vite.text()).includes("vite"), "Controlled legacy fixture requires Vite source modules");
  await mockApiAtServiceTime(page);
  await page.goto("/");
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/services/cityData.ts";
    const {useCityDataStore} = await import(path);
    return (useCityDataStore.getState().active?.values("gtfsShapes").length ?? 0) > 0;
  })).toBe(true);
  const expected = await page.evaluate(async () => {
    const paths = ["/src/db/index.ts", "/src/services/cityData.ts", "/src/services/gtfsBundle.ts",
      "/src/stores/cityStore.ts", "/src/services/sharedCityArtifacts.ts"];
    const [{db}, {useCityDataStore}, {encodeGzipJson}, {useCityStore}, {clearSharedArtifactMemory}] = await Promise.all(paths.map(path => import(path)));
    const active = useCityDataStore.getState().active;
    const city = useCityStore.getState().activeCity;
    const shapes = active.values("gtfsShapes");
    const packed = await encodeGzipJson(active.wire);
    await db.offlineCities.put({cityId: city.id, city, preparedAt: Date.now(), sizeBytes: 1, tables: {
      gtfsSyncMeta: [active.meta], gtfsShapes: shapes,
      ptbBytes: [{...active.artifact.ptb, cityId: city.id}],
      gtfsBundle: [{cityId: city.id, format: "gzip", compressedBytes: packed.compressed,
        compressedSize: packed.compressed.byteLength, decompressedSize: packed.decompressedSize}],
    }});
    await db.offlineCityMetadata.put({cityId: city.id, state: "legacy"});
    clearSharedArtifactMemory();
    await Promise.all([db.cityArtifacts.clear(), db.cityArtifactMetadata.clear(), db.cityCachePointers.clear(),
      db.cityShapes.clear(), db.gtfsShapes.clear(), db.gtfsTrips.clear(), db.gtfsSyncMeta.clear(), db.ptbBytes.clear(), db.gtfsBundle.clear()]);
    return {cityId: city.id, generationId: active.token.generationId,
      shapeId: shapes[0].shapeId, encodedPolyline: shapes[0].encodedPolyline};
  });
  // Keep the development app shell reachable while removing every API. Real
  // service-worker shell-offline coverage belongs to the offline project.
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", {get: () => false, configurable: true}));
  await page.route("**/api/**", route => route.abort());
  await page.reload({waitUntil: "domcontentloaded"});
  await expect.poll(async () => page.evaluate(async expected => {
    const paths = ["/src/services/cityData.ts", "/src/stores/gtfsDataStore.ts", "/src/db/index.ts"];
    const [{useCityDataStore}, {useGtfsDataStore}, {db}] = await Promise.all(paths.map(path => import(path)));
    const active = useCityDataStore.getState().active;
    return {cityId: useGtfsDataStore.getState().loadedCityId, generationId: active?.token.generationId,
      polyline: active?.get("gtfsShapes", expected.shapeId)?.encodedPolyline,
      projectedTrips: await db.gtfsTrips.count(), projectedShapes: await db.gtfsShapes.count(),
      originalRetained: !!await db.offlineCities.get(expected.cityId)};
  }, expected), {timeout: 25_000}).toEqual({cityId: expected.cityId, generationId: expected.generationId,
    polyline: expected.encodedPolyline, projectedTrips: 0, projectedShapes: 0, originalRetained: true});
});
