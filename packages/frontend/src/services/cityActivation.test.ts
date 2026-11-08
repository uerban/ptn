import "fake-indexeddb/auto";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {db} from "../db/index.ts";
import {useCityStore} from "../stores/cityStore.ts";
import {prepareCityArtifact, publishCityArtifact, readCityArtifact} from "./cityArtifacts.ts";
import {clearCityArtifactMemory} from "./cityArtifactMemory.ts";
import {prepareCityActivation} from "./cityActivation.ts";
import {activateCityData, CityDataContext, invalidateCityData} from "./cityData.ts";

const mocks = vi.hoisted(() => ({fetch: vi.fn(), decode: vi.fn()}));
vi.mock("./verifiedCityCatalog.ts", () => ({fetchVerifiedPtb: mocks.fetch}));
vi.mock("./ptbCatalogWorkerClient.ts", () => ({decodePtbCatalogInWorker: mocks.decode}));
const initialCity = useCityStore.getState().activeCity;
beforeEach(async () => { clearCityArtifactMemory(); invalidateCityData(); await db.delete(); await db.open(); vi.clearAllMocks(); });
afterEach(() => { invalidateCityData(); useCityStore.setState({activeCity: initialCity}); vi.unstubAllGlobals(); });
async function fixture() {
  const bytes = new Uint8Array([1, 2, 3]);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    value => value.toString(16).padStart(2, "0")).join("");
  const artifact = await prepareCityArtifact(initialCity.id, {generationId: "a", bundleSha256: hash,
    generatedAt: "today", cityTzIana: "UTC"}, {bytes, etag: `"${hash}"`, fromCache: false,
    networkValidated: true, transfersResolved: true});
  const wire = {meta: {cityId: initialCity.id, generatedAt: "today", cityTzIana: "UTC"},
    stops: [{id: "stop", name: "Stop", lat: 1, lon: 2}], routes: [], calendar: []};
  mocks.decode.mockResolvedValue(wire);
  mocks.fetch.mockResolvedValue({ptb: artifact.ptb, generation: artifact.generation});
  return {artifact, wire};
}

it("prepares a cached city without a network request or any legacy projection reads", async () => {
  const {artifact, wire} = await fixture();
  await publishCityArtifact(artifact, null);
  const forbidden = vi.spyOn(db.gtfsTrips, "toArray").mockRejectedValue(new Error("projection read"));
  try {
    const prepared = await prepareCityActivation(initialCity.id);
    expect(prepared.context.wire).toBe(wire);
    expect(prepared.context.artifact?.key).toBe(artifact.key);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
  } finally { forbidden.mockRestore(); }
});

it("returns a fresh decoded context before publishing its durable pointer", async () => {
  const {artifact, wire} = await fixture();
  const prepared = await prepareCityActivation(initialCity.id);
  expect(mocks.fetch).toHaveBeenCalledWith(initialCity.id, {persist: false, cached: undefined});
  expect(prepared.context.wire).toBe(wire);
  expect(await db.cityCachePointers.count()).toBe(0);
  expect(await db.gtfsTrips.count()).toBe(0);
  expect(await prepared.persist()).toBe(true);
  expect((await db.cityCachePointers.get(initialCity.id))?.artifactKey).toBe(artifact.key);
});

it("revalidates installed bytes without decoding or replacing an unchanged context", async () => {
  const {artifact, wire} = await fixture();
  const context = new CityDataContext(wire, {id: "current", cityId: initialCity.id,
    generationId: artifact.generation.generationId, etag: artifact.ptb.etag, generatedAt: "today", lastSynced: 1}, [], artifact);
  activateCityData(context);
  const prepared = await prepareCityActivation(initialCity.id, {requireNetwork: true});
  expect(mocks.fetch).toHaveBeenCalledWith(initialCity.id, {persist: false, cached: artifact.ptb});
  expect(mocks.decode).not.toHaveBeenCalled();
  expect(prepared.unchanged).toBe(true);
  expect(prepared.context).toBe(context);
});

it("cannot publish an activation after a city switch during decoding", async () => {
  const {wire} = await fixture();
  let finish!: (value: typeof wire) => void;
  mocks.decode.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
  const pending = prepareCityActivation(initialCity.id);
  const rejected = expect(pending).rejects.toMatchObject({name: "AbortError"});
  await vi.waitFor(() => expect(mocks.decode).toHaveBeenCalledOnce());
  useCityStore.setState({activeCity: {...initialCity, id: "other"}});
  finish(wire);
  await rejected;
  expect(await db.cityArtifacts.count()).toBe(0);
});

it("replaces a corrupt cached catalog online without deleting the last durable artifact first", async () => {
  const {artifact, wire} = await fixture();
  await publishCityArtifact(artifact, null);
  mocks.decode.mockRejectedValueOnce(new Error("corrupt cached PTB")).mockResolvedValueOnce(wire);
  const prepared = await prepareCityActivation(initialCity.id);
  expect(prepared.fromCache).toBe(false);
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(await db.cityArtifacts.count()).toBe(1);
  expect(prepared.context.wire).toBe(wire);
});

it("repairs corrupt bytes even when the verified network generation has the same immutable key", async () => {
  const {artifact} = await fixture();
  await publishCityArtifact(artifact, null);
  await db.cityArtifacts.put({...artifact, ptb: {...artifact.ptb, bytes: new Uint8Array([9])}});
  const prepared = await prepareCityActivation(initialCity.id);
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(Array.from((await db.cityArtifacts.get(artifact.key))!.ptb.bytes)).toEqual([9]);
  expect(await prepared.persist()).toBe(true);
  expect(Array.from((await readCityArtifact(initialCity.id))!.ptb.bytes)).toEqual([1, 2, 3]);
});

it("turns a late network rejection into cancellation when the selected city changed", async () => {
  await fixture();
  let fail!: (reason: Error) => void;
  mocks.fetch.mockReturnValueOnce(new Promise((_resolve, reject) => {fail = reject;}));
  const pending = prepareCityActivation(initialCity.id);
  const rejected = expect(pending).rejects.toMatchObject({name: "AbortError"});
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
  useCityStore.setState({activeCity: {...initialCity, id: "other"}});
  fail(new Error("network failed after city switch"));
  await rejected;
  expect(await db.cityArtifacts.count()).toBe(0);
});

it("recovers a retained download after online startup fails, but never hides a required-network update failure", async () => {
  const {artifact} = await fixture();
  await publishCityArtifact(artifact, null);
  await db.offlineCityMetadata.put({cityId: initialCity.id, state: "complete", artifactKey: artifact.key});
  await db.cityCachePointers.delete(initialCity.id);
  mocks.fetch.mockRejectedValue(new Error("network unavailable"));
  const prepared = await prepareCityActivation(initialCity.id);
  expect(prepared.context.artifact?.key).toBe(artifact.key);
  expect(prepared.fromCache).toBe(true);
  await expect(prepareCityActivation(initialCity.id, {requireNetwork: true})).rejects.toThrow("network unavailable");
});

it("opens a retained artifact directly offline when its ordinary cache pointer was collected", async () => {
  const {artifact} = await fixture();
  await publishCityArtifact(artifact, null);
  await db.offlineCityMetadata.put({cityId: initialCity.id, state: "complete", artifactKey: artifact.key});
  await db.cityCachePointers.delete(initialCity.id);
  vi.stubGlobal("navigator", {onLine: false});
  const prepared = await prepareCityActivation(initialCity.id);
  expect(prepared.context.artifact?.key).toBe(artifact.key);
  expect(mocks.fetch).not.toHaveBeenCalled();
});


it("acquires a cached catalog and its publication boundary without a duplicate pointer read", async () => {
  const {artifact} = await fixture();
  await publishCityArtifact(artifact, null);
  const pointers = vi.spyOn(db.cityCachePointers, "get");
  const prepared = await prepareCityActivation(initialCity.id);
  expect(prepared.fromCache).toBe(true);
  expect(prepared.context.artifact?.key).toBe(artifact.key);
  expect(pointers).toHaveBeenCalledOnce();
  pointers.mockRestore();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
