import type { PrivacyLevel } from "@pt/shared";

/**
 * Failure modes for install-key acquisition. Each represents a distinct
 * runtime degradation:
 *
 * - `no-crypto`           — WebCrypto `generateKey` rejected (algorithm
 *                           unsupported / SubtleCrypto absent). No encryption
 *                           is possible at all this session.
 * - `no-persist`          — Key generated, but the IndexedDB write was
 *                           rejected (e.g. QuotaExceededError). The key lives
 *                           only in memory and is lost on reload.
 * - `no-structured-clone` — Browser refused to structured-clone a
 *                           non-extractable CryptoKey into IndexedDB
 *                           (DataCloneError). Same effect as `no-persist`:
 *                           usable now, lost on reload.
 */
export type DegradedMode =
  | "no-crypto"
  | "no-persist"
  | "no-structured-clone";

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

/**
 * Effective tier for callers that asked for `"encrypted"` writes when the
 * install key is unavailable. Baseline / Standard fall back to plaintext;
 * higher levels keep `"encrypted"` (the call will throw, and the UI surfaces
 * the warning) so we never silently downgrade a Hardened+ user.
 */
export function fallbackTierForLevel(
  level: PrivacyLevel,
  mode: DegradedMode | null,
): "encrypted" | "plaintext" {
  if (mode !== "no-crypto") return "encrypted";
  return level === "baseline" || level === "standard"
    ? "plaintext"
    : "encrypted";
}

/**
 * Whether the current user level should see a visible "encryption
 * unavailable — privacy level fallback applied." warning. Hardened and above
 * have requested encryption guarantees we cannot meet; lower levels run on
 * plaintext anyway so a warning would only add noise.
 */
export function shouldWarnAtLevel(
  level: PrivacyLevel,
  mode: DegradedMode | null = currentMode,
): boolean {
  if (!mode) return false;
  return level !== "baseline" && level !== "standard";
}

/** i18n-key surfaced by the warning banner. */
export const DEGRADED_WARNING_I18N_KEY = "privacy.installKey.degradedWarning";

/** Test-only: clears mode + listeners between vitest runs. */
export function __resetDegradedModeForTests(): void {
  currentMode = null;
  listeners.clear();
}
