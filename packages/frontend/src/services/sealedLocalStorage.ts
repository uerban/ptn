/**
 * Encrypted values in localStorage, for personal state kept there (favorites,
 * the last map area, delay reports). Values are sealed with the install key,
 * so reading and writing are asynchronous: persisted stores hydrate after the
 * key is available and render a loading state until then.
 *
 * A stored value is never overwritten unless it was read successfully (or was
 * absent) this session. Legacy plaintext waiting for the storage migration and
 * ciphertext that does not decrypt are left untouched; until the rider deletes
 * them, changes to that state are kept for the session only.
 */
import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { decrypt, encrypt } from "./cryptoBox.ts";
import { durablePersonalKey, reportUnreadable } from "./personalStorage.ts";
import { MAP_VIEWPORT_STORAGE_KEY } from "./privacyStorageKeys.ts";
import { safeLocalStorage } from "./tolerantLocalStorage.ts";

const SEALED_FORMAT = "ptn-sealed";

interface SealedEnvelope {
  format: typeof SEALED_FORMAT;
  v: number;
  iv: string;
  ct: string;
}

type ItemStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function toBase64(buf: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(buf)) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

function parseEnvelope(raw: string): SealedEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SealedEnvelope> | null;
    if (
      parsed &&
      parsed.format === SEALED_FORMAT &&
      typeof parsed.v === "number" &&
      typeof parsed.iv === "string" &&
      typeof parsed.ct === "string"
    ) {
      return parsed as SealedEnvelope;
    }
  } catch {
    // Not JSON: not ours either.
  }
  return null;
}

/** Whether a raw localStorage value is a sealed envelope. */
export function isSealedValue(raw: string | null): boolean {
  return raw !== null && parseEnvelope(raw) !== null;
}

export async function sealString(value: string, key: CryptoKey): Promise<string> {
  const rec = await encrypt(value, key);
  const envelope: SealedEnvelope = {
    format: SEALED_FORMAT,
    v: rec.v,
    iv: toBase64(rec.iv),
    ct: toBase64(rec.ct),
  };
  return JSON.stringify(envelope);
}

/** Throws when `raw` is not a sealed envelope or does not decrypt. */
export async function openSealedString(raw: string, key: CryptoKey): Promise<string> {
  const envelope = parseEnvelope(raw);
  if (!envelope) throw new Error("not a sealed value");
  const value = await decrypt(
    { v: envelope.v, iv: fromBase64(envelope.iv), ct: fromBase64(envelope.ct) },
    key,
  );
  if (typeof value !== "string") throw new Error("sealed value is not a string");
  return value;
}

/** Names whose stored value may be replaced this session. */
const writable = new Set<string>();
/**
 * Bumped by every write and removal, so a write that finishes after a newer
 * write or a removal cannot store an older value.
 */
const generations = new Map<string, number>();

/**
 * Reads and decrypts a value. Null when it is absent, not yet converted,
 * unreadable, or when only session storage is possible.
 */
export async function readSealedItem(
  name: string,
  storage: ItemStorage | undefined = safeLocalStorage(),
): Promise<string | null> {
  const key = await durablePersonalKey();
  if (!key || !storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(name);
  } catch {
    return null;
  }
  if (raw === null) {
    writable.add(name);
    reportUnreadable(name, 0);
    return null;
  }
  // Plaintext from before encryption: the storage migration converts it.
  if (!isSealedValue(raw)) return null;
  try {
    const value = await openSealedString(raw, key);
    writable.add(name);
    reportUnreadable(name, 0);
    return value;
  } catch {
    reportUnreadable(name, 1);
    return null;
  }
}

/** Seals and stores a value. Returns false when it was kept in memory only. */
export async function writeSealedItem(
  name: string,
  value: string,
  storage: ItemStorage | undefined = safeLocalStorage(),
): Promise<boolean> {
  if (!storage || !writable.has(name)) return false;
  const generation = (generations.get(name) ?? 0) + 1;
  generations.set(name, generation);
  const key = await durablePersonalKey();
  if (!key) return false;
  const sealed = await sealString(value, key);
  if ((generations.get(name) ?? 0) !== generation || !writable.has(name)) {
    return false;
  }
  try {
    storage.setItem(name, sealed);
    return true;
  } catch {
    return false;
  }
}

/** Removes a value, readable or not. Later writes may store a new one. */
export function removeSealedItem(
  name: string,
  storage: Pick<Storage, "removeItem"> | undefined = safeLocalStorage(),
): void {
  generations.set(name, (generations.get(name) ?? 0) + 1);
  try {
    storage?.removeItem(name);
  } catch {
    // Storage unavailable: nothing was stored either.
  }
  writable.add(name);
  reportUnreadable(name, 0);
}

/** Async zustand storage that keeps the persisted state sealed. */
export const sealedStateStorage: StateStorage = {
  getItem: (name) => readSealedItem(name),
  setItem: async (name, value) => {
    await writeSealedItem(name, value);
  },
  removeItem: (name) => removeSealedItem(name),
};

export function createSealedJSONStorage<S>() {
  return createJSONStorage<S>(() => sealedStateStorage);
}

/**
 * The last viewed map area (see utils/mapViewport.ts), with a synchronous
 * in-memory view for the map's start-up. `load()` runs once before first use.
 */
let mapViewportValue: string | null = null;
export const mapViewportItem = {
  async load(): Promise<void> {
    mapViewportValue = await readSealedItem(MAP_VIEWPORT_STORAGE_KEY);
  },
  get: (): string | null => mapViewportValue,
  set(next: string): void {
    mapViewportValue = next;
    void writeSealedItem(MAP_VIEWPORT_STORAGE_KEY, next).catch(() => {});
  },
  remove(storage: Pick<Storage, "removeItem"> | undefined = safeLocalStorage()): void {
    mapViewportValue = null;
    removeSealedItem(MAP_VIEWPORT_STORAGE_KEY, storage);
  },
};

/** Test-only: forgets which values may be replaced. */
export function __resetSealedLocalStorageForTests(): void {
  writable.clear();
  generations.clear();
}
