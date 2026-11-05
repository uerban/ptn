import {
  ADDRESS_SEARCH_ARTIFACT_SCHEMA_VERSION,
  type AddressSearchArtifactManifest,
} from "@pt/shared/address-search";
import { db, type AddressSearchArtifactRecord } from "../db/index.ts";
import { notifyWriteGrew, onQuotaNear, registerEvictor } from "./storagePolicy.ts";
import { reportError } from "./errorReporter.ts";
import * as self from "./addressSearchLoader.ts";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const activeSyncs = new Map<string, Promise<boolean>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`address-search ${key} must be a string`);
  return value;
}

function parseManifest(raw: unknown, cityId: string): AddressSearchArtifactManifest {
  if (!isRecord(raw)) throw new Error("address-search manifest must be an object");
  if (raw.schemaVersion !== ADDRESS_SEARCH_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`unsupported address-search manifest schema ${String(raw.schemaVersion)}`);
  }
  if (raw.cityId !== cityId) {
    throw new Error(`address-search manifest city mismatch: ${String(raw.cityId)}`);
  }
  if (typeof raw.generatedAt !== "string" || raw.generatedAt.length === 0) {
    throw new Error("address-search manifest generatedAt must be a string");
  }
  if (typeof raw.artifactUrl !== "string" || raw.artifactUrl.length === 0) {
    throw new Error("address-search manifest artifactUrl must be a string");
  }
  if (typeof raw.sha256 !== "string" || !SHA256_HEX.test(raw.sha256)) {
    throw new Error("address-search manifest sha256 must be lowercase hex");
  }
  if (!isNonNegativeInteger(raw.sizeBytes)) {
    throw new Error("address-search manifest sizeBytes must be a non-negative integer");
  }
  if (!isNonNegativeInteger(raw.rowCount) || !isNonNegativeInteger(raw.keyCount)) {
    throw new Error("address-search manifest rowCount/keyCount must be non-negative integers");
  }
  return {
    schemaVersion: ADDRESS_SEARCH_ARTIFACT_SCHEMA_VERSION,
    cityId,
    generatedAt: raw.generatedAt,
    artifactUrl: raw.artifactUrl,
    sha256: raw.sha256,
    sizeBytes: raw.sizeBytes,
    rowCount: raw.rowCount,
    keyCount: raw.keyCount,
    source: optionalString(raw, "source"),
    bundleGenerationId: optionalString(raw, "bundleGenerationId"),
  };
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isQuotaError(error: unknown): boolean {
  return error instanceof Error && error.name === "QuotaExceededError";
}

export async function fetchAddressSearchManifest(
  cityId: string,
  signal?: AbortSignal,
): Promise<AddressSearchArtifactManifest | null> {
  const res = await fetch(`/api/${cityId}/address-search/manifest`, {
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`address-search manifest HTTP ${res.status}`);
  return parseManifest(await res.json(), cityId);
}

/**
 * Fetch the packed artifact and verify it before it is allowed near storage.
 *
 * Returns raw bytes, deliberately: the artifact IS the built index, so nothing
 * here parses it — the buffer goes to storage as-is and the wasm index reads it
 * in place. `Content-Encoding` is transparent to `fetch`, so `sizeBytes` and
 * `sha256` are checked against the DECODED body either way.
 */
export async function fetchAddressSearchArtifact(
  manifest: AddressSearchArtifactManifest,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const url = new URL(manifest.artifactUrl, globalThis.location.origin).toString();
  const res = await fetch(url, {
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!res.ok) throw new Error(`address-search bundle HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength !== manifest.sizeBytes) {
    throw new Error("address-search bundle size mismatch");
  }
  const actualSha = await sha256Hex(buffer);
  if (actualSha !== manifest.sha256) {
    throw new Error("address-search bundle sha256 mismatch");
  }
  return buffer;
}

export function syncAddressSearch(cityId: string): Promise<boolean> {
  const active = activeSyncs.get(cityId);
  if (active) return active;
  const controller = new AbortController();
  const work: Promise<boolean> = syncAddressSearchInner(cityId, controller.signal)
    .catch((error) => {
      if (!isAbortError(error)) {
        reportError(error instanceof Error ? error : new Error(String(error)), {
          context: { source: "addressSearch.sync", cityId },
        });
      }
      return false;
    })
    .finally(() => {
      if (activeSyncs.get(cityId) === work) activeSyncs.delete(cityId);
    });
  activeSyncs.set(cityId, work);
  return work;
}

async function syncAddressSearchInner(cityId: string, signal: AbortSignal): Promise<boolean> {
  const manifest = await self.fetchAddressSearchManifest(cityId, signal);
  if (manifest === null) {
    await clearAddressSearch(cityId);
    return false;
  }

  const cached = await db.addressSearchArtifacts.get(cityId);
  if (
    cached !== undefined &&
    cached.sha256 === manifest.sha256 &&
    cached.sizeBytes === manifest.sizeBytes &&
    cached.rowCount === manifest.rowCount &&
    cached.keyCount === manifest.keyCount
  ) {
    return false;
  }

  const bytes = await self.fetchAddressSearchArtifact(manifest, signal);
  const record: AddressSearchArtifactRecord = {
    cityId,
    sha256: manifest.sha256,
    sizeBytes: manifest.sizeBytes,
    generatedAt: manifest.generatedAt,
    installedAt: Date.now(),
    rowCount: manifest.rowCount,
    keyCount: manifest.keyCount,
    source: manifest.source,
    bundleGenerationId: manifest.bundleGenerationId,
    bytes,
  };

  const write = () => db.addressSearchArtifacts.put(record);
  try {
    await write();
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    const evicted = await onQuotaNear();
    if (evicted.length === 0) throw error;
    await write();
  }
  await notifyWriteGrew();
  return true;
}

export async function clearAddressSearch(cityId?: string): Promise<void> {
  if (cityId) {
    await db.addressSearchArtifacts.delete(cityId);
  } else {
    await db.addressSearchArtifacts.clear();
  }
}

export function __resetAddressSearchLoaderForTests(): void {
  activeSyncs.clear();
}

registerEvictor("addressSearch", () => clearAddressSearch());
