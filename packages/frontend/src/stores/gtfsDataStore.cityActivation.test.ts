import "fake-indexeddb/auto";
import {beforeEach, afterEach, expect, it, vi} from "vitest";
import type {RoutingBundleData} from "@pt/shared";
import {CityDataContext, captureCityData, useCityDataStore} from "../services/cityData.ts";
import {useCityStore} from "./cityStore.ts";
import {useGtfsDataStore} from "./gtfsDataStore.ts";

const mocks = vi.hoisted(() => ({prepare: vi.fn(), build: vi.fn(), sync: vi.fn(), clear: vi.fn(), engine: vi.fn()}));
vi.mock("../services/cityActivation.ts", () => ({prepareCityActivation: mocks.prepare}));
vi.mock("../services/raptorIndex.ts", () => ({buildRaptorIndex: mocks.build}));
vi.mock("../services/gtfsSync.ts", () => ({syncGtfsData: mocks.sync, needsSync: vi.fn(), clearGtfsData: mocks.clear}));
vi.mock("../db/migrationRunner.ts", () => ({ensureDbReady: async () => ({recovered: false})}));
vi.mock("../services/osrmWasm.ts", () => ({osrmClient: {init: async () => {}}}));
vi.mock("../services/wasmLifecycle.ts", () => ({initOrSwapPtRouter: (...args: unknown[]) => mocks.engine(...args)}));

const originalCity = useCityStore.getState().activeCity;
function prepared(generationId = "a") {
  const cityId = useCityStore.getState().activeCity.id;
  const wire: RoutingBundleData = {meta: {cityId, generatedAt: "2026-11-07", cityTzIana: "UTC"},
    stops: [{id: "same-stop", name: generationId, lat: 1, lon: 2}], routes: [], calendar: []};
  const context = new CityDataContext(wire, {id: "current", cityId, etag: generationId,
    generationId, generatedAt: wire.meta.generatedAt, lastSynced: 1}, [], {
      key: generationId, cityId, generation: {generationId, bundleSha256: generationId,
        cityTzIana: "UTC", generatedAt: wire.meta.generatedAt},
      ptb: {bytes: new Uint8Array([1]), etag: generationId, fromCache: false,
        networkValidated: true, transfersResolved: true},
    });
  return {context, fromCache: false, unchanged: false, persist: vi.fn().mockResolvedValue(true)};
}
beforeEach(async () => {
  mocks.clear.mockResolvedValue(undefined);
  await useGtfsDataStore.getState().reset();
  vi.clearAllMocks();
  mocks.build.mockResolvedValue({cityTzIana: "UTC"});
  mocks.engine.mockImplementation(() => new Promise(() => {}));
});
afterEach(async () => { await useGtfsDataStore.getState().reset(); useCityStore.setState({activeCity: originalCity}); });

it("makes the decoded city ready while disk persistence remains pending, without a projection sync", async () => {
  const city = prepared();
  city.persist.mockReturnValue(new Promise(() => {}));
  mocks.prepare.mockResolvedValue(city);
  await useGtfsDataStore.getState().init(originalCity.id);
  expect(mocks.build).toHaveBeenCalledWith({cityId: originalCity.id,
    signal: expect.any(AbortSignal), wire: city.context.wire});
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(useGtfsDataStore.getState()).toMatchObject({loadedCityId: originalCity.id, syncing: false, persistence: "pending"});
  expect((await captureCityData().gtfsStops.get("same-stop"))?.name).toBe("a");
});

it("makes the planner ready while optional persistence never settles", async () => {
  const city = prepared();
  city.persist.mockReturnValue(new Promise(() => {}));
  mocks.prepare.mockResolvedValue(city);
  const router = {free: vi.fn()};
  mocks.engine.mockImplementation(async () => {
    useGtfsDataStore.getState().setPtRouter(router as never);
    return router;
  });
  await useGtfsDataStore.getState().init(originalCity.id);
  await vi.waitFor(() => expect(useGtfsDataStore.getState().wasmEngine.status).toBe("ready"));
  expect(useGtfsDataStore.getState().persistence).toBe("pending");
  expect(useGtfsDataStore.getState().raptorIndex).not.toBeNull();
  expect(useGtfsDataStore.getState().ptRouter).toBe(router);
});

it("retains the installed timetable if its durable write fails", async () => {
  const city = prepared();
  city.persist.mockRejectedValue(new Error("quota"));
  mocks.prepare.mockResolvedValue(city);
  await useGtfsDataStore.getState().init(originalCity.id);
  await vi.waitFor(() => expect(useGtfsDataStore.getState().persistence).toBe("failed"));
  expect(useGtfsDataStore.getState().raptorIndex).not.toBeNull();
  expect(useCityDataStore.getState().active).toBe(city.context);
});

it("keeps one complete generation while refresh is pending or fails", async () => {
  const a = prepared();
  mocks.prepare.mockResolvedValueOnce(a);
  await useGtfsDataStore.getState().init(originalCity.id);
  const oldIndex = useGtfsDataStore.getState().raptorIndex;
  let fail!: (reason: Error) => void;
  mocks.prepare.mockImplementationOnce(() => new Promise((_resolve, reject) => {fail = reject;}));
  const refresh = useGtfsDataStore.getState().refresh(originalCity.id);
  await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2));
  expect(useCityDataStore.getState().active).toBe(a.context);
  expect(useGtfsDataStore.getState().raptorIndex).toBe(oldIndex);
  expect(useGtfsDataStore.getState()).toMatchObject({syncing: false, refreshing: true});
  fail(new Error("offline"));
  await refresh;
  expect(useCityDataStore.getState().active).toBe(a.context);
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("serves a cached city immediately while starting its online refresh independently", async () => {
  const a = {...prepared(), fromCache: true};
  mocks.prepare.mockResolvedValueOnce(a).mockReturnValueOnce(new Promise(() => {}));
  await useGtfsDataStore.getState().init(originalCity.id);
  await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2));
  expect(mocks.prepare.mock.calls[1]).toEqual([originalCity.id,
    {requireNetwork: true, signal: expect.any(AbortSignal)}]);
  expect(useGtfsDataStore.getState()).toMatchObject({syncing: false, refreshing: true, loadedCityId: originalCity.id});
  expect(useCityDataStore.getState().active).toBe(a.context);
});

it("discards a prepared activation completed after reset", async () => {
  const a = prepared();
  let finish!: (value: ReturnType<typeof prepared>) => void;
  mocks.prepare.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const init = useGtfsDataStore.getState().init(originalCity.id);
  await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
  await useGtfsDataStore.getState().reset();
  finish(a);
  await init;
  expect(useCityDataStore.getState().active).toBeNull();
  expect(useGtfsDataStore.getState().raptorIndex).toBeNull();
  expect(a.persist).not.toHaveBeenCalled();
});

it("switches the resident context without clearing or waiting for legacy projection storage", async () => {
  mocks.clear.mockReturnValueOnce(new Promise<void>(() => {}));
  await useGtfsDataStore.getState().reset();
  mocks.prepare.mockResolvedValueOnce(prepared());
  await useGtfsDataStore.getState().init(originalCity.id);
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(useGtfsDataStore.getState().loadedCityId).toBe(originalCity.id);
});

it("supersedes a pending city with no resident index and rejects its late catalog", async () => {
  const a = prepared();
  let finish!: (value: ReturnType<typeof prepared>) => void;
  mocks.prepare.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const old = useGtfsDataStore.getState().init(originalCity.id);
  await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
  const oldSignal = mocks.prepare.mock.calls[0][1].signal as AbortSignal;
  useCityStore.setState({activeCity: {...originalCity, id: "other"}});
  const b = prepared("b");
  mocks.prepare.mockResolvedValueOnce(b);
  await useGtfsDataStore.getState().init("other");
  expect(oldSignal.aborted).toBe(true);
  finish(a);
  await old;
  expect(useCityDataStore.getState().active).toBe(b.context);
  expect(useGtfsDataStore.getState().loadedCityId).toBe("other");
  expect(a.persist).not.toHaveBeenCalled();
});

it("passes explicit download selection and required-network updates to acquisition", async () => {
  mocks.prepare.mockResolvedValue(prepared());
  await useGtfsDataStore.getState().init(originalCity.id, {preferDownload: true});
  expect(mocks.prepare.mock.calls[0][1]).toMatchObject({preferDownload: true});
  mocks.prepare.mockRejectedValueOnce(new Error("offline"));
  await useGtfsDataStore.getState().refresh(originalCity.id, {requireNetwork: true});
  expect(mocks.prepare.mock.calls[1][1]).toMatchObject({requireNetwork: true});
  expect(useGtfsDataStore.getState().error).toContain("offline");
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("preserves index, context, and ready engine on unchanged revalidation", async () => {
  const city = prepared();
  const router = {free: vi.fn(), isAlive: () => true, plan: () => []};
  mocks.engine.mockImplementation(async () => {
    useGtfsDataStore.getState().setPtRouter(router as never);
    return router;
  });
  mocks.prepare.mockResolvedValueOnce(city);
  await useGtfsDataStore.getState().init(originalCity.id);
  await vi.waitFor(() => expect(useGtfsDataStore.getState().wasmEngine.status).toBe("ready"));
  const index = useGtfsDataStore.getState().raptorIndex;
  const revision = useCityDataStore.getState().revision;
  mocks.prepare.mockResolvedValueOnce({...city, unchanged: true});
  await useGtfsDataStore.getState().refresh(originalCity.id);
  expect(mocks.build).toHaveBeenCalledOnce();
  expect(mocks.engine).toHaveBeenCalledOnce();
  expect(useGtfsDataStore.getState().raptorIndex).toBe(index);
  expect(useCityDataStore.getState().revision).toBe(revision);
  expect(useGtfsDataStore.getState().ptRouter).toBe(router);
  expect(useGtfsDataStore.getState().wasmEngine).toMatchObject({status: "ready",
    initGeneration: useGtfsDataStore.getState().getInitGeneration()});
});
