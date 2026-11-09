import type {CityArtifactRecord} from "../db/index.ts";
import {sharedArtifactEpoch} from "./sharedCityArtifacts.ts";

// Binary-only warm revisits. One decoded context remains owned by cityData.
// Both the item count and byte cost are bounded, including unusually large feeds.
export const CITY_ARTIFACT_MEMORY_BYTES = 24 * 1024 * 1024;
const entries = new Map<string, CityArtifactRecord>();
let bytes = 0;
let epoch = sharedArtifactEpoch();

export function clearCityArtifactMemory(): void {
  entries.clear();
  bytes = 0;
  epoch = sharedArtifactEpoch();
}

function checkEpoch(): void {
  if (epoch !== sharedArtifactEpoch()) clearCityArtifactMemory();
}

/** Only callers that have verified the immutable artifact may insert it. */
export function rememberCityArtifact(artifact: CityArtifactRecord): void {
  checkEpoch();
  const previous = entries.get(artifact.key);
  if (previous) { bytes -= previous.ptb.bytes.byteLength; entries.delete(artifact.key); }
  const size = artifact.ptb.bytes.byteLength;
  if (size > CITY_ARTIFACT_MEMORY_BYTES) return;
  entries.set(artifact.key, artifact);
  bytes += size;
  while (entries.size > 2 || bytes > CITY_ARTIFACT_MEMORY_BYTES) {
    const oldest = entries.keys().next().value!;
    bytes -= entries.get(oldest)!.ptb.bytes.byteLength;
    entries.delete(oldest);
  }
}

/** Resolve the current durable pointer before asking for a memo entry. */
export function recalledCityArtifact(key: string): CityArtifactRecord | undefined {
  checkEpoch();
  const artifact = entries.get(key);
  if (artifact) { entries.delete(key); entries.set(key, artifact); }
  return artifact;
}
