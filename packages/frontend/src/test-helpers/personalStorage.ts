/**
 * Test helpers for sealed personal storage: reset every layer between tests
 * and inspect what IndexedDB and localStorage actually hold.
 */
import { db } from "../db/index.ts";
import { __resetInstallKeyCacheForTests } from "../services/installKey.ts";
import { __resetDegradedModeForTests } from "../services/installKeyDegrade.ts";
import {
  PERSONAL_STORAGE_MARKER_KEY,
  PERSONAL_STORAGE_VERSION,
  __resetPersonalStorageForTests,
  __settlePersonalStorageMigrationForTests,
} from "../services/personalStorage.ts";
import {
  __resetSealedLocalStorageForTests,
  isSealedValue,
} from "../services/sealedLocalStorage.ts";
import {
  PRIVACY_DATA_MIGRATION_KEY,
  PRIVACY_DATA_MIGRATION_VERSION,
} from "../services/privacyDataMigrationState.ts";

export interface ResetPersonalStorageOptions {
  /** Mark the device as already converted (default true). */
  migrated?: boolean;
}

/** Clears personal tables, keys, caches and markers. */
export async function resetPersonalStorage(
  opts: ResetPersonalStorageOptions = {},
): Promise<void> {
  await __settlePersonalStorageMigrationForTests();
  if (!db.isOpen()) await db.open();
  await Promise.all([
    db.installKey.clear(),
    db.recentLocations.clear(),
    db.savedLocations.clear(),
    db.personalUsage.clear(),
    db.usageStats.clear(),
    db.cityUsageStats.clear(),
    db.geocoderDedup.clear(),
  ]);
  __resetInstallKeyCacheForTests();
  __resetDegradedModeForTests();
  __resetPersonalStorageForTests();
  __resetSealedLocalStorageForTests();
  localStorage.setItem(PRIVACY_DATA_MIGRATION_KEY, PRIVACY_DATA_MIGRATION_VERSION);
  if (opts.migrated ?? true) {
    localStorage.setItem(PERSONAL_STORAGE_MARKER_KEY, PERSONAL_STORAGE_VERSION);
  } else {
    localStorage.removeItem(PERSONAL_STORAGE_MARKER_KEY);
  }
}

type Binary = ArrayBuffer | ArrayBufferView;

// Rows read back from IndexedDB hold buffers from another realm, which fail
// `instanceof ArrayBuffer`; the brand check works across realms.
function isArrayBuffer(v: unknown): v is ArrayBuffer {
  return Object.prototype.toString.call(v) === "[object ArrayBuffer]";
}

function isBinary(v: unknown): v is Binary {
  return isArrayBuffer(v) || ArrayBuffer.isView(v);
}

function bytesOf(v: Binary): Uint8Array {
  return isArrayBuffer(v)
    ? new Uint8Array(v)
    : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * Ciphertext buffers (the `iv` and `ct` of an encrypted record) are rendered
 * as `<sealed:BASE64>` so `findLeaks` can skip them: random bytes can spell a
 * short needle by chance.
 */
const SEALED_BYTES_PATTERN = /<sealed:[A-Za-z0-9+/]*={0,2}>/g;

function isCiphertextHolder(holder: unknown): boolean {
  if (!holder || typeof holder !== "object") return false;
  const rec = holder as { iv?: unknown; ct?: unknown };
  return isBinary(rec.iv) && isBinary(rec.ct);
}

/** Every raw row of a table, serialised the way a forensic reader would see it. */
export async function rawTableText(table: string): Promise<string> {
  const rows = await db.table(table).toArray();
  return JSON.stringify(rows, function (this: unknown, k: string, v: unknown) {
    if (!isBinary(v)) return v;
    const bytes = bytesOf(v);
    if ((k === "iv" || k === "ct") && isCiphertextHolder(this)) {
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return `<sealed:${btoa(binary)}>`;
    }
    // Decode other buffers as text so a plaintext label inside one would still show.
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  });
}

/** Every localStorage value, concatenated. */
export function rawLocalStorageText(): string {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key) out.push(`${key}=${localStorage.getItem(key) ?? ""}`);
  }
  return out.join("\n");
}

/** A sealed localStorage envelope as `sealString` writes it. */
const SEALED_ENVELOPE_PATTERN = /\{"format":"ptn-sealed","v":(\d+),"iv":"[^"]*","ct":"[^"]*"\}/g;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function blankEnvelope(match: string, v: string): string {
  if (!isSealedValue(match)) return match;
  const { iv, ct } = JSON.parse(match) as { iv: string; ct: string };
  // Only a real base64 payload is ciphertext; anything else stays searchable.
  if (!BASE64.test(iv) || !BASE64.test(ct)) return match;
  return `{"format":"ptn-sealed","v":${v},"iv":"","ct":""}`;
}

/** Removes ciphertext payloads, leaving every other character searchable. */
export function withoutCiphertext(haystack: string): string {
  return haystack
    .replace(SEALED_ENVELOPE_PATTERN, blankEnvelope)
    .replace(SEALED_BYTES_PATTERN, "<sealed>");
}

/**
 * The needles found in `haystack` outside ciphertext payloads (sealed
 * localStorage envelopes and the encrypted-record buffers `rawTableText`
 * renders). Expect an empty result.
 */
export function findLeaks(haystack: string, needles: readonly string[]): string[] {
  const text = withoutCiphertext(haystack);
  return needles.filter((n) => text.includes(n));
}
