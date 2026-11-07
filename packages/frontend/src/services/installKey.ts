import { db, type InstallKeyRecord } from "../db/index.ts";
import {
  type DegradedMode,
  getDegradedMode,
  setDegradedMode,
} from "./installKeyDegrade.ts";

export class InstallKeyError extends Error {
  readonly mode: DegradedMode;
  readonly cause?: unknown;
  constructor(mode: DegradedMode, message: string, cause?: unknown) {
    super(message);
    this.name = "InstallKeyError";
    this.mode = mode;
    this.cause = cause;
  }
}

/** A failed key read is retried after this long, not on every call. */
export const KEY_READ_RETRY_MS = 30_000;

type KeyRowId = InstallKeyRecord["id"];

interface KeySpec {
  readonly id: KeyRowId;
  readonly generate: () => Promise<CryptoKey>;
  readonly algorithm: string;
}

const AES_KEY: KeySpec = {
  id: "current",
  algorithm: "AES-GCM",
  generate: () =>
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
};

const HMAC_KEY: KeySpec = {
  id: "hmac",
  algorithm: "HMAC",
  generate: () =>
    crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]) as Promise<CryptoKey>,
};

interface KeyState {
  key: CryptoKey | null;
  /** True when the key exists only in memory and is lost on reload. */
  sessionOnly: boolean;
  pending: Promise<CryptoKey> | null;
  readBlockedUntil: number;
}

const states = new Map<KeyRowId, KeyState>();
let now: () => number = Date.now;

function stateFor(id: KeyRowId): KeyState {
  let state = states.get(id);
  if (!state) {
    state = { key: null, sessionOnly: false, pending: null, readBlockedUntil: 0 };
    states.set(id, state);
  }
  return state;
}

/** Duck-typed so a key cloned across realms (jsdom, workers) still counts. */
function isUsableKey(value: unknown, algorithm: string): value is CryptoKey {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CryptoKey>;
  return (
    candidate.type === "secret" &&
    Array.isArray(candidate.usages) &&
    (candidate.algorithm as { name?: unknown } | undefined)?.name === algorithm
  );
}

function errorName(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return undefined;
  const name = (e as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function keyReadFailed(state: KeyState, cause: unknown): never {
  state.readBlockedUntil = now() + KEY_READ_RETRY_MS;
  setDegradedMode("read-failed");
  throw new InstallKeyError("read-failed", "Install key could not be read", cause);
}

function clearRecoveredReadFailure(): void {
  if (getDegradedMode() === "read-failed") setDegradedMode(null);
}

async function acquire(spec: KeySpec): Promise<CryptoKey> {
  const state = stateFor(spec.id);
  if (now() < state.readBlockedUntil) {
    throw new InstallKeyError(
      getDegradedMode() ?? "read-failed",
      "Install key unavailable; retrying later",
    );
  }

  // "No key row" and "the read failed" are different: only the first may
  // create a key. Writing a new key after a failed read would make every
  // record sealed with the stored key unreadable.
  let row: InstallKeyRecord | undefined;
  try {
    row = await db.installKey.get(spec.id);
  } catch (cause) {
    keyReadFailed(state, cause);
  }
  if (row) {
    if (!isUsableKey(row.key, spec.algorithm)) {
      // Never replaced automatically; deleting the personal data it protected
      // is the only way to start over (see resetInstallKeys).
      state.readBlockedUntil = Number.POSITIVE_INFINITY;
      setDegradedMode("key-unreadable");
      throw new InstallKeyError("key-unreadable", "Stored install key is not usable");
    }
    state.key = row.key;
    state.sessionOnly = false;
    clearRecoveredReadFailure();
    return row.key;
  }

  let key: CryptoKey;
  try {
    key = await spec.generate();
  } catch (cause) {
    setDegradedMode("no-crypto");
    throw new InstallKeyError("no-crypto", "WebCrypto generateKey unavailable", cause);
  }

  try {
    // `add`, not `put`: another tab may have created the key since the read.
    await db.installKey.add({ id: spec.id, key });
  } catch (cause) {
    if (errorName(cause) === "ConstraintError") {
      let winner: InstallKeyRecord | undefined;
      try {
        winner = await db.installKey.get(spec.id);
      } catch (readCause) {
        keyReadFailed(state, readCause);
      }
      if (winner && isUsableKey(winner.key, spec.algorithm)) {
        state.key = winner.key;
        state.sessionOnly = false;
        return winner.key;
      }
    }
    state.key = key;
    state.sessionOnly = true;
    setDegradedMode(
      errorName(cause) === "DataCloneError" ? "no-structured-clone" : "no-persist",
    );
    return key;
  }

  state.key = key;
  state.sessionOnly = false;
  clearRecoveredReadFailure();
  return key;
}

function getOrCreate(spec: KeySpec): Promise<CryptoKey> {
  const state = stateFor(spec.id);
  if (state.key) return Promise.resolve(state.key);
  if (!state.pending) {
    state.pending = acquire(spec).finally(() => {
      state.pending = null;
    });
  }
  return state.pending;
}

/**
 * Returns the install key (non-extractable AES-GCM 256), generating and
 * persisting it when no key row exists.
 *
 * On failure paths it sets the module-scoped `DegradedMode`:
 *   - `no-crypto`           — generateKey rejected; throws `InstallKeyError`.
 *   - `no-persist`          — IDB write rejected (e.g. QuotaExceededError);
 *                             returns a session-only key, lost on reload.
 *   - `no-structured-clone` — IDB write rejected with DataCloneError;
 *                             returns a session-only key, lost on reload.
 *   - `read-failed`         — the key row could not be read; throws and
 *                             retries the read after `KEY_READ_RETRY_MS`.
 *   - `key-unreadable`      — the stored row holds no usable key; throws.
 *
 * A session-only key must never seal anything written to storage: check
 * `isInstallKeyDurable()` (personal storage does this for every write).
 */
export function getOrCreateInstallKey(): Promise<CryptoKey> {
  return getOrCreate(AES_KEY);
}

/**
 * Non-extractable HMAC-SHA-256 key for keyed lookup identifiers (for example
 * cache keys derived from searches), with the same lifecycle as the install
 * key.
 */
export function getOrCreateHmacKey(): Promise<CryptoKey> {
  return getOrCreate(HMAC_KEY);
}

/** Whether every acquired key is persisted, so ciphertext survives reload. */
export function isInstallKeyDurable(): boolean {
  if (getDegradedMode() !== null) return false;
  for (const state of states.values()) {
    if (state.key && state.sessionOnly) return false;
  }
  return true;
}

/** Lets the next request re-read a key whose read failed, without waiting. */
export function retryInstallKeyReadNow(): void {
  for (const state of states.values()) {
    if (Number.isFinite(state.readBlockedUntil)) state.readBlockedUntil = 0;
  }
}

/**
 * Removes the stored keys. Only for "delete my personal data": everything the
 * keys protected becomes unreadable, so callers delete it in the same step.
 */
export async function resetInstallKeys(): Promise<void> {
  await db.installKey.clear();
  states.clear();
  setDegradedMode(null);
}

/** Test-only: drops the cached keys so each test boots from a clean slate. */
export function __resetInstallKeyCacheForTests(): void {
  states.clear();
  now = Date.now;
}

/** Test-only: drives the read-retry clock. */
export function __setInstallKeyClockForTests(clock: () => number): void {
  now = clock;
}
