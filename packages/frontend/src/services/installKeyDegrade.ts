/**
 * Reasons the install key cannot back durable encrypted storage this session.
 * Every mode means the same thing to personal-data writers: keep records in
 * memory for the session and write nothing to storage.
 *
 * - `no-crypto`           — WebCrypto `generateKey` rejected (algorithm
 *                           unsupported / SubtleCrypto absent). No encryption
 *                           is possible at all this session.
 * - `no-persist`          — Key generated, but the IndexedDB write was
 *                           rejected (e.g. QuotaExceededError). The key lives
 *                           only in memory and is lost on reload.
 * - `no-structured-clone` — Browser refused to structured-clone a
 *                           non-extractable CryptoKey into IndexedDB
 *                           (DataCloneError). Same effect as `no-persist`.
 * - `read-failed`         — Reading the stored key failed. The stored key is
 *                           left untouched (replacing it would make every
 *                           existing record unreadable) and the read is
 *                           retried later.
 * - `key-unreadable`      — A key row exists but does not hold a usable key.
 *                           It is never replaced automatically; only deleting
 *                           the personal data it protected starts over.
 */
export type DegradedMode =
  | "no-crypto"
  | "no-persist"
  | "no-structured-clone"
  | "read-failed"
  | "key-unreadable";

let currentMode: DegradedMode | null = null;
const listeners = new Set<(mode: DegradedMode | null) => void>();

export function getDegradedMode(): DegradedMode | null {
  return currentMode;
}

export function setDegradedMode(mode: DegradedMode | null): void {
  if (currentMode === mode) return;
  currentMode = mode;
  for (const fn of listeners) fn(mode);
}

export function subscribeDegradedMode(
  fn: (mode: DegradedMode | null) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test-only: clears mode + listeners between vitest runs. */
export function __resetDegradedModeForTests(): void {
  currentMode = null;
  listeners.clear();
}
