import type { BaseEndpoint } from "@pt/shared";
import { LEVEL_FLOORS, type PrivacyLevel, type PrivacyPolicy } from "@pt/shared/privacy";
import { db, type SavedLocationRecord } from "../db/index.ts";
import { decrypt, encrypt, type EncryptedRecord } from "./cryptoBox.ts";
import { getOrCreateInstallKey } from "./installKey.ts";
import { getPolicy, registerLevelChangeListener } from "../stores/privacyStore.ts";

import { useCityStore } from "../stores/cityStore.ts";

export type SavesTier = "plaintext" | "encrypted";

/**
 * Collapse the 5-way `savesEncryption` axis onto the 2 storage tiers relevant
 * at the T-19 save-this-pair level. "opt-in" leaves encryption off by default;
 * every stricter axis forces encryption.
 */
export function tierForSavesAxis(
  axis: PrivacyPolicy["savesEncryption"],
): SavesTier {
  if (axis === "opt-in") return "plaintext";
  return "encrypted";
}

/**
 * Whether the per-save "sensitive" toggle is user-controllable at this axis.
 * Baseline ("opt-in") and Standard ("default") let the user choose per save;
 * Hardened+ always encrypts and surfaces no toggle.
 */
export function isSensitiveToggleAvailable(
  axis: PrivacyPolicy["savesEncryption"],
): boolean {
  return axis === "opt-in" || axis === "default";
}

/** Default checkbox state for the user-facing "sensitive" toggle. */
export function defaultSensitiveForAxis(
  axis: PrivacyPolicy["savesEncryption"],
): boolean {
  return tierForSavesAxis(axis) === "encrypted";
}

/**
 * Whether the alias (user-visible label) must be sealed inside the encrypted
 * payload rather than persisted as a queryable plaintext column. Only the
 * Paranoid axis (`always-no-share`) requires this; every other axis keeps the
 * alias readable for sort/filter.
 */
export function shouldEncryptAlias(
  axis: PrivacyPolicy["savesEncryption"],
): boolean {
  return axis === "always-no-share";
}

/**
 * Whether the "export save" action is available at the given policy axis.
 * Strict (`always-no-export`) and Paranoid (`always-no-share`) suppress
 * export; all lower axes allow it.
 */
export function canExportSaves(
  axis: PrivacyPolicy["savesEncryption"],
): boolean {
  return axis !== "always-no-export" && axis !== "always-no-share";
}

/**
 * Whether the "share save" action is available at the given policy axis.
 * Only Paranoid (`always-no-share`) suppresses sharing; every lower axis
 * (Baseline / Standard / Hardened / Strict) allows it.
 */
export function canShareSaves(
  axis: PrivacyPolicy["savesEncryption"],
): boolean {
  return axis !== "always-no-share";
}

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface SaveRoutePairInput {
  origin: BaseEndpoint;
  destination: BaseEndpoint;
  /** Optional user-visible label; empty string is treated as absent. */
  alias?: string;
  /**
   * Per-save "sensitive" toggle (M8c T-21). When set, forces the encryption
   * tier regardless of the current policy default: `true` → encrypted,
   * `false` → plaintext. Only meaningful at axes where
   * `isSensitiveToggleAvailable()` is true (Baseline / Standard); stricter
   * axes always encrypt and ignore this hint. Omitted → follow policy.
   */
  sensitive?: boolean;
}

export interface SavePlaceInput {
  /** The single location being saved (already reduced through its own seam). */
  endpoint: BaseEndpoint;
  /** Optional user-visible label; empty string is treated as absent. */
  alias?: string;
  /** Per-save "sensitive" toggle — same semantics as `SaveRoutePairInput`. */
  sensitive?: boolean;
}

export interface SaveRoutePairOptions {
  /** Test hook: override the clock. */
  now?: () => number;
  /** Test hook: override the resolved tier (bypasses policy lookup). */
  tier?: SavesTier;
  /** Test hook: override the generated id. */
  id?: string;
  /**
   * Test hook: override whether to seal the alias inside the encrypted payload
   * (bypasses the policy-axis lookup). Only meaningful at `encrypted` tier;
   * ignored at `plaintext`.
   */
  encryptAlias?: boolean;
}

/**
 * One-tap save of an (origin, destination, alias?) tuple from the route
 * results view. Encryption follows the current `savesEncryption` policy:
 * plaintext at Baseline/Standard (opt-in), encrypted from Hardened upward.
 * The record is stored in `savedLocations` with both endpoints; pair saves
 * always carry `destinationEndpoint` set.
 */
export async function saveRoutePair(
  input: SaveRoutePairInput,
  opts: SaveRoutePairOptions = {},
): Promise<SavedLocationRecord> {
  return writeSave(input, opts);
}

/**
 * Save of a single location (no destination leg) — the map long-press
 * "Save with label" flow. Stored in the same `savedLocations` table at the
 * same encryption tier as a pair save; readers distinguish the two by the
 * absence of `destinationEndpoint` (`PinnedSavesSection`).
 *
 * The caller owns the precision seam: pass an endpoint already reduced by
 * `mapTapStore`, never a raw tap coord.
 */
export async function savePlace(
  input: SavePlaceInput,
  opts: SaveRoutePairOptions = {},
): Promise<SavedLocationRecord> {
  return writeSave(
    {
      origin: input.endpoint,
      ...(input.alias !== undefined ? { alias: input.alias } : {}),
      ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
    },
    opts,
  );
}

async function writeSave(
  input: {
    origin: BaseEndpoint;
    destination?: BaseEndpoint;
    alias?: string;
    sensitive?: boolean;
  },
  opts: SaveRoutePairOptions,
): Promise<SavedLocationRecord> {
  // Capture ownership before encryption yields to a possible city switch.
  const cityId = useCityStore.getState().activeCity.id;
  const axis = getPolicy().savesEncryption;
  const policyTier = tierForSavesAxis(axis);
  // Per-save override is honored only at axes that expose the toggle; at
  // Hardened+ the axis is authoritative and `sensitive` is a no-op.
  const sensitiveTier: SavesTier | undefined =
    input.sensitive !== undefined && isSensitiveToggleAvailable(axis)
      ? input.sensitive
        ? "encrypted"
        : "plaintext"
      : undefined;
  const tier = opts.tier ?? sensitiveTier ?? policyTier;
  const savedAt = opts.now ? opts.now() : Date.now();
  const id = opts.id ?? genId();
  const alias = (input.alias ?? "").trim();
  const encryptAlias =
    tier === "encrypted" &&
    (opts.encryptAlias ?? shouldEncryptAlias(axis));

  let storedOrigin: BaseEndpoint | EncryptedRecord = input.origin;
  let storedDest: BaseEndpoint | EncryptedRecord | undefined = input.destination;
  let aliasCipher: EncryptedRecord | undefined;
  let storedAlias = alias;
  if (tier === "encrypted") {
    const key = await getOrCreateInstallKey();
    storedOrigin = await encrypt(input.origin, key);
    if (input.destination !== undefined) {
      storedDest = await encrypt(input.destination, key);
    }
    if (encryptAlias && alias !== "") {
      aliasCipher = await encrypt(alias, key);
      storedAlias = "";
    }
  }

  const record: SavedLocationRecord = {
    id,
    cityId,
    endpoint: storedOrigin,
    // Omitted entirely for single-place saves — readers branch on presence.
    ...(storedDest !== undefined ? { destinationEndpoint: storedDest } : {}),
    alias: storedAlias,
    savedAt,
    encrypted: tier === "encrypted",
    ...(aliasCipher ? { aliasCipher } : {}),
  };
  await db.savedLocations.put(record);
  return record;
}

/**
 * The on-disk shape a saved row takes for a given `savesEncryption` axis.
 * Three states are distinguishable from the user's perspective:
 * - `plaintext`: endpoints raw, alias plaintext (Baseline opt-in).
 * - `encrypted`: endpoints sealed, alias still plaintext for sort/filter.
 * - `encrypted-sealed-alias`: endpoints sealed AND alias migrated inside the
 *   ciphertext (Paranoid only — see `shouldEncryptAlias`).
 */
export type SavesState =
  | "plaintext"
  | "encrypted"
  | "encrypted-sealed-alias";

export function stateForSavesAxis(
  axis: PrivacyPolicy["savesEncryption"],
): SavesState {
  if (axis === "opt-in") return "plaintext";
  if (axis === "always-no-share") return "encrypted-sealed-alias";
  return "encrypted";
}

function isEncryptedShape(x: unknown): x is EncryptedRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return "iv" in r && "ct" in r && "v" in r;
}

/**
 * Re-encodes every saved location so it lives at the storage state implied by
 * `next`. Triggered by the privacyStore level-change listener (registered
 * below). Behaviour by transition:
 * - plaintext ↔ encrypted: rewrites endpoints at the new tier in place.
 * - encrypted ↔ encrypted-sealed-alias: seals or unseals the alias only; the
 *   endpoint ciphertext is rotated as well so the row is internally consistent.
 * - encrypted → plaintext (downgrade): decrypts endpoints and any sealed alias
 *   back to clear form. The user-facing warning is delivered upstream by the
 *   privacyStore confirm callback; this function only performs the rewrite.
 *
 * Rows whose endpoint shape doesn't match the inferred prev tier (e.g. a row
 * seeded by a test bypassing `saveRoutePair`) are passed through best-effort
 * rather than failing the whole migration.
 */
export async function migrateSavesForLevelChange(
  prev: PrivacyLevel,
  next: PrivacyLevel,
): Promise<void> {
  const prevState = stateForSavesAxis(LEVEL_FLOORS[prev].savesEncryption);
  const nextState = stateForSavesAxis(LEVEL_FLOORS[next].savesEncryption);
  if (prevState === nextState) return;

  const rows = await db.savedLocations.toArray();
  if (rows.length === 0) return;

  let key: CryptoKey | null = null;
  const ensureKey = async (): Promise<CryptoKey> => {
    if (key === null) key = await getOrCreateInstallKey();
    return key;
  };

  const rewritten: SavedLocationRecord[] = [];

  for (const row of rows) {
    let origin: BaseEndpoint;
    if (isEncryptedShape(row.endpoint)) {
      try {
        origin = (await decrypt(row.endpoint, await ensureKey())) as BaseEndpoint;
      } catch {
        continue;
      }
    } else {
      origin = row.endpoint;
    }

    let destination: BaseEndpoint | undefined;
    if (row.destinationEndpoint !== undefined) {
      if (isEncryptedShape(row.destinationEndpoint)) {
        try {
          destination = (await decrypt(
            row.destinationEndpoint,
            await ensureKey(),
          )) as BaseEndpoint;
        } catch {
          continue;
        }
      } else {
        destination = row.destinationEndpoint;
      }
    }

    let alias: string;
    if (row.aliasCipher !== undefined) {
      try {
        alias = (await decrypt(row.aliasCipher, await ensureKey())) as string;
      } catch {
        // Keep the sealed record recoverable if this installation cannot
        // decrypt its alias. Replacing it with the empty display alias loses it.
        continue;
      }
    } else {
      alias = row.alias;
    }

    let storedOrigin: BaseEndpoint | EncryptedRecord = origin;
    let storedDest: BaseEndpoint | EncryptedRecord | undefined = destination;
    let storedAlias = alias;
    let aliasCipher: EncryptedRecord | undefined;

    if (nextState !== "plaintext") {
      const k = await ensureKey();
      storedOrigin = await encrypt(origin, k);
      if (destination !== undefined) {
        storedDest = await encrypt(destination, k);
      }
      if (nextState === "encrypted-sealed-alias" && alias !== "") {
        aliasCipher = await encrypt(alias, k);
        storedAlias = "";
      }
    }

    const next: SavedLocationRecord = {
      id: row.id,
      ...(row.cityId !== undefined ? { cityId: row.cityId } : {}),
      endpoint: storedOrigin,
      ...(storedDest !== undefined ? { destinationEndpoint: storedDest } : {}),
      alias: storedAlias,
      savedAt: row.savedAt,
      ...(row.pinColor !== undefined ? { pinColor: row.pinColor } : {}),
      encrypted: nextState !== "plaintext",
      ...(aliasCipher ? { aliasCipher } : {}),
    };
    rewritten.push(next);
  }

  // JSON's default ArrayBuffer representation is {}, which would consider
  // different encrypted edits identical. Include the actual ciphertext bytes.
  const version = (row: SavedLocationRecord) => JSON.stringify(row, (_key, value) =>
    Object.prototype.toString.call(value) === "[object ArrayBuffer]"
      ? Array.from(new Uint8Array(value as ArrayBuffer)) : value);
  const originals = new Map(rows.map(row => [row.id, version(row)]));
  await db.transaction("rw", db.savedLocations, async () => {
    for (const rec of rewritten) {
      const current = await db.savedLocations.get(rec.id);
      // Encryption runs outside the transaction. Preserve concurrent edits,
      // deletions and new saves, including those owned by another city.
      if (current && version(current) === originals.get(rec.id)) {
        await db.savedLocations.put(rec);
      }
    }
  });
}

registerLevelChangeListener(migrateSavesForLevelChange);
