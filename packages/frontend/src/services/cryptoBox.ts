import type { Table } from "dexie";

export const RECORD_VERSION = 1;

export interface EncryptedRecord {
  v: number;
  iv: ArrayBuffer;
  ct: ArrayBuffer;
}

export type CryptoBoxErrorCode =
  | "ciphertext-corrupted"
  | "key-missing"
  | "version-mismatch";

export class CryptoBoxError extends Error {
  readonly code: CryptoBoxErrorCode;
  constructor(code: CryptoBoxErrorCode, message?: string) {
    super(message ?? code);
    this.name = "CryptoBoxError";
    this.code = code;
  }
}

const IV_BYTES = 12;
const ALGO = "AES-GCM";

export async function encrypt(
  plaintext: unknown,
  key: CryptoKey,
): Promise<EncryptedRecord> {
  if (!key) throw new CryptoBoxError("key-missing");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(JSON.stringify(plaintext));
  const ctBuf = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);
  // Copy both into fresh ArrayBuffers so they survive jsdom / Node realm boundaries.
  const ivCopy = new ArrayBuffer(iv.byteLength);
  new Uint8Array(ivCopy).set(iv);
  const ctCopy = new ArrayBuffer(ctBuf.byteLength);
  new Uint8Array(ctCopy).set(new Uint8Array(ctBuf));
  return { v: RECORD_VERSION, iv: ivCopy, ct: ctCopy };
}

export async function decrypt(
  rec: EncryptedRecord,
  key: CryptoKey,
): Promise<unknown> {
  if (!key) throw new CryptoBoxError("key-missing");
  if (rec.v !== RECORD_VERSION) {
    throw new CryptoBoxError(
      "version-mismatch",
      `unsupported record version: ${String(rec.v)} (expected ${RECORD_VERSION})`,
    );
  }
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: ALGO, iv: new Uint8Array(rec.iv) },
      key,
      new Uint8Array(rec.ct),
    );
  } catch {
    throw new CryptoBoxError("ciphertext-corrupted");
  }
  const text = new TextDecoder().decode(plain);
  return JSON.parse(text);
}

// ── Tier dispatch ───────────────────────────────────────────────────────────

export type Tier = "plaintext" | "encrypted" | "ram-only";

export interface EncryptedRow {
  id: string;
  encrypted: EncryptedRecord;
}

interface RecordWithId {
  id: string;
}

export interface TierOptions {
  tier: Tier;
  /** Required when tier === "encrypted". */
  key?: CryptoKey;
}

const ramStore = new Map<string, unknown>();

function ramKey(table: Table, id: string): string {
  return `${table.name}:${id}`;
}

export async function writeRecord<T extends RecordWithId>(
  table: Table,
  value: T,
  options: TierOptions,
): Promise<void> {
  switch (options.tier) {
    case "plaintext":
      await table.put(value);
      return;
    case "encrypted": {
      if (!options.key) throw new CryptoBoxError("key-missing");
      const encrypted = await encrypt(value, options.key);
      const row: EncryptedRow = { id: value.id, encrypted };
      await table.put(row);
      return;
    }
    case "ram-only":
      ramStore.set(ramKey(table, value.id), value);
      return;
  }
}

export async function readRecord<T extends RecordWithId>(
  table: Table,
  id: string,
  options: TierOptions,
): Promise<T | null> {
  switch (options.tier) {
    case "plaintext": {
      const row = (await table.get(id)) as T | undefined;
      return row ?? null;
    }
    case "encrypted": {
      if (!options.key) throw new CryptoBoxError("key-missing");
      const row = (await table.get(id)) as EncryptedRow | undefined;
      if (!row) return null;
      const value = (await decrypt(row.encrypted, options.key)) as T;
      return value;
    }
    case "ram-only": {
      const value = ramStore.get(ramKey(table, id)) as T | undefined;
      return value ?? null;
    }
  }
}

export function listRamRecords<T>(table: Table): T[] {
  const prefix = `${table.name}:`;
  const out: T[] = [];
  for (const [k, v] of ramStore.entries()) {
    if (k.startsWith(prefix)) out.push(v as T);
  }
  return out;
}

export function deleteRamRecord(table: Table, id: string): void {
  ramStore.delete(ramKey(table, id));
}

export function clearRamRecordsForTable(table: Table): void {
  const prefix = `${table.name}:`;
  for (const k of Array.from(ramStore.keys())) {
    if (k.startsWith(prefix)) ramStore.delete(k);
  }
}

/** Test-only: clears the in-memory RAM-only store. */
export function __clearRamStoreForTests(): void {
  ramStore.clear();
}
