import { fetchPtbBytes, type FetchPtbBytesOptions } from "./gtfsBundleBytes.ts";
import { fetchPtbCatalogGeneration } from "./ptbCatalog.ts";

/** Bracket PTB acquisition with authoritative ready generations so neither
 * a replica switch nor a sidecar-only publication mixes provenance. */
export async function fetchVerifiedPtb(cityId: string, options?: FetchPtbBytesOptions) {
  const [before, ptb] = await Promise.all([
    fetchPtbCatalogGeneration(cityId),
    options ? fetchPtbBytes(cityId, options) : fetchPtbBytes(cityId),
  ]);
  if (!ptb.networkValidated) {
    throw new Error("ptb catalog: bundle bytes were not network-validated");
  }
  if (ptb.etag !== `"${before.bundleSha256}"`) {
    throw new Error(
      `ptb catalog: bundle ETag does not match ready generation (${String(ptb.etag)} != ${before.bundleSha256})`,
    );
  }
  if (ptb.cityTzIana !== undefined && ptb.cityTzIana !== before.cityTzIana) {
    throw new Error(
      `ptb catalog: bundle timezone does not match ready generation (${ptb.cityTzIana} != ${before.cityTzIana})`,
    );
  }
  const after = await fetchPtbCatalogGeneration(cityId);
  if (
    before.generationId !== after.generationId ||
    before.bundleSha256 !== after.bundleSha256 ||
    before.cityTzIana !== after.cityTzIana ||
    before.shapesArtifact?.hash !== after.shapesArtifact?.hash ||
    before.shapesArtifact?.sizeBytes !== after.shapesArtifact?.sizeBytes
  ) {
    throw new Error(
      `ptb catalog: generation provenance changed during fetch (${before.generationId} -> ${after.generationId})`,
    );
  }
  return {ptb, generation: after};
}
