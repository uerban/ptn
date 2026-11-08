import type {RoutingBundleData} from "@pt/shared";
import {CityDataContext, StaleCityDataError, useCityDataStore} from "./cityData.ts";
import {canonicalCityId} from "../utils/cityId.ts";
import {useCityStore} from "../stores/cityStore.ts";
import {fetchVerifiedPtb} from "./verifiedCityCatalog.ts";
import {decodePtbCatalogInWorker} from "./ptbCatalogWorkerClient.ts";
import {cityArtifactPointer, prepareCityArtifact, publishCityArtifact, readCityArtifact, readCityArtifactSnapshot,
  collectCityArtifacts} from "./cityArtifacts.ts";
import {measureCityStage} from "./cityPerformance.ts";
import type {CityArtifactRecord} from "../db/index.ts";
import {readLegacyCityArtifact} from "./legacyCityArtifact.ts";

export interface PreparedCity {
  context: CityDataContext;
  fromCache: boolean;
  unchanged: boolean;
  /** Persistence is separate from readiness. A quota failure must leave the
   * usable in-memory city and previous complete disk generation intact. */
  persist(): Promise<boolean>;
}

export async function prepareCityActivation(cityId: string, options: {
  signal?: AbortSignal; requireNetwork?: boolean; preferDownload?: boolean;
} = {}): Promise<PreparedCity> {
  cityId = canonicalCityId(cityId);
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    if (canonicalCityId(useCityStore.getState().activeCity.id) !== cityId) throw new StaleCityDataError();
  };
  assertCurrent();
  let expectedKey = options.requireNetwork ? await cityArtifactPointer(cityId) : null;
  assertCurrent();
  let artifact: CityArtifactRecord | undefined;
  const installed = useCityDataStore.getState().active;
  const revalidationCache = installed?.token.cityId === cityId ? installed.artifact?.ptb : undefined;
  let fresh = false;
  let repairPayload = false;
  let unchanged = false;
  let wire: RoutingBundleData | undefined;
  try {
    if (!options.requireNetwork) {
      const snapshot = await measureCityStage(cityId, "catalog-cache-read", () => readCityArtifactSnapshot(cityId, options.preferDownload ?? navigator.onLine === false));
      expectedKey = snapshot.pointerKey;
      artifact = snapshot.artifact;
      assertCurrent();
      if (!artifact) {
        artifact = await readLegacyCityArtifact(cityId, options.preferDownload ?? navigator.onLine === false);
        assertCurrent();
      }
      if (artifact) {
        const local = artifact;
        wire = await measureCityStage(cityId, "catalog-decode", () => decodePtbCatalogInWorker(local.ptb.bytes,
          {cityId, generation: local.generation,
            ...(local.ptb.transfersArtifact ? {transfersArtifact: local.ptb.transfersArtifact} : {})}, options.signal));
      }
    }
  } catch (error) {
    assertCurrent();
    // A corrupt local cache is replaceable online. Retain its original bytes
    // until a complete replacement is published; offline report the failure.
    if (navigator.onLine === false) throw error;
    artifact = undefined;
    repairPayload = true;
    // No verified snapshot escaped the failed read. Capture the repair CAS
    // boundary before fetching its replacement, retaining the original bytes.
    expectedKey = await cityArtifactPointer(cityId);
    assertCurrent();
  }
  if (!wire) {
    try {
      const {ptb, generation} = await measureCityStage(cityId, "catalog-fetch", () => fetchVerifiedPtb(cityId,
        {persist: false, cached: revalidationCache}));
      assertCurrent();
      const previous = installed?.artifact;
      if (previous && useCityDataStore.getState().active === installed && installed.token.cityId === cityId && generation.generationId === previous.generation.generationId &&
          ptb.etag === previous.ptb.etag && generation.bundleSha256 === previous.generation.bundleSha256 &&
          generation.cityTzIana === previous.generation.cityTzIana &&
          ptb.transfersArtifact?.hash === previous.ptb.transfersArtifact?.hash &&
          generation.shapesArtifact?.hash === previous.generation.shapesArtifact?.hash) {
        wire = installed.wire;
        artifact = previous;
        unchanged = true;
      } else {
        wire = await measureCityStage(cityId, "catalog-decode", () => decodePtbCatalogInWorker(ptb.bytes,
          {cityId, generation, ...(ptb.transfersArtifact ? {transfersArtifact: ptb.transfersArtifact} : {})}, options.signal));
        assertCurrent();
        artifact = await prepareCityArtifact(cityId, generation, ptb);
      }
      fresh = true;
    } catch (error) {
      assertCurrent();
      if (options.requireNetwork) throw error;
      // Online startup can recover a retained download after a network
      // failure, without restoring its global projection tables.
      const retained = await readCityArtifact(cityId, true) ?? await readLegacyCityArtifact(cityId, true);
      assertCurrent();
      if (!retained) throw error;
      wire = await decodePtbCatalogInWorker(retained.ptb.bytes, {cityId, generation: retained.generation,
        ...(retained.ptb.transfersArtifact ? {transfersArtifact: retained.ptb.transfersArtifact} : {})}, options.signal);
      artifact = retained;
      fresh = false;
    }
  }
  if (!artifact) throw new Error("City activation has no verified artifact");
  assertCurrent();
  const context = unchanged ? installed! : new CityDataContext(wire, {id: "current", cityId,
    etag: artifact.ptb.etag, generationId: artifact.generation.generationId,
    generatedAt: wire.meta.generatedAt, lastSynced: fresh ? Date.now() : 0,
    transfersHash: artifact.ptb.transfersArtifact?.hash, shapesHash: artifact.generation.shapesArtifact?.hash,
    ...(wire.frequencies?.length ? {frequencies: wire.frequencies} : {})}, [], artifact);
  return {context, fromCache: !fresh, unchanged, persist: async () => {
    assertCurrent();
    const published = await publishCityArtifact(artifact, expectedKey, options.signal, repairPayload);
    if (published) await collectCityArtifacts(artifact.key);
    return published;
  }};
}
