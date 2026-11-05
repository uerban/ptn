import { db } from "../db/index.ts";
import {
  type DegradedMode,
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

let cachedKey: CryptoKey | null = null;

/**
 * Returns the install key (non-extractable AES-GCM 256), generating and
 * persisting it on first use. Subsequent calls return the same CryptoKey
 * instance from Dexie.
 *
 * On failure paths it sets the module-scoped `DegradedMode`:
 *   - `no-crypto`           — generateKey rejected; throws `InstallKeyError`.
 *   - `no-persist`          — IDB put rejected (e.g. QuotaExceededError);
 *                             returns the in-memory key, lost on reload.
 *   - `no-structured-clone` — IDB put rejected with DataCloneError; returns
 *                             the in-memory key, lost on reload.
 *
 * Callers must check `getDegradedMode()` to surface the user-facing warning.
 */
export async function getOrCreateInstallKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  try {
    const row = await db.installKey.get("current");
    if (row?.key) {
      cachedKey = row.key;
      setDegradedMode(null);
      return row.key;
    }
  } catch {
    // Fall through to generation; persist attempt below will record the
    // appropriate degraded mode if it also fails.
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch (cause) {
    setDegradedMode("no-crypto");
    throw new InstallKeyError(
      "no-crypto",
      "WebCrypto generateKey unavailable",
      cause,
    );
  }

  try {
    await db.installKey.put({ id: "current", key });
  } catch (cause) {
    cachedKey = key;
    const mode: DegradedMode = isStructuredCloneError(cause)
      ? "no-structured-clone"
      : "no-persist";
    setDegradedMode(mode);
    return key;
  }

  cachedKey = key;
  setDegradedMode(null);
  return key;
}

function isStructuredCloneError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const name = (e as { name?: unknown }).name;
  return name === "DataCloneError";
}

/** Test-only: drops the cached key so each test boots from a clean slate. */
export function __resetInstallKeyCacheForTests(): void {
  cachedKey = null;
}
