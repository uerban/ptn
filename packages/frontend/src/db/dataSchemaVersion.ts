import { reportError } from "../services/errorReporter.ts";
import { db, TABLE_KIND, type PtnTableName } from "./index.ts";
import { PATTERN_MODE, PatternMode } from "@pt/shared/raptor";

/**
 * On-device data schema version. The on-device STAMP is the composite
 * `${DATA_SCHEMA_VERSION}:${mode}` — folding the active PatternMode in so any
 * mode change wipes server-derived caches exactly once on first boot of the
 * new build. The numeric component bumps on a row-contents contract change;
 * the mode is an orthogonal dimension folded into the same stamp.
 *
 * This complements Dexie's structural schema rather than replacing it: Dexie
 * handles "table-shape changed" (add/remove tables, change indexes); this
 * handles "the contract on row contents changed without a structural diff"
 * (new required field on a JSON blob, cached PTB byte format, GTFS bundle
 * codec change, etc.).
 *
 * The wipe is driven by stamp string inequality, so it fires on an upgrade and
 * on a rollback alike. That matters because `fetchPtbBytesPreferCache` (the
 * wasm visibility-resume path) serves cached bytes without re-fetching: a
 * client that cannot read the cached format would otherwise fail closed until
 * the cache is cleared by hand.
 *
 * Tables marked `"user-owned"` in `TABLE_KIND` are deliberately
 * preserved across bumps — installKey, recentLocations, savedLocations,
 * usageStats. Adding a new table to `db/index.ts` requires classifying
 * it in `TABLE_KIND`, so the wipe set stays in sync automatically.
 */
export const DATA_SCHEMA_VERSION = 1;

const STORAGE_KEY = "ptn:dataSchemaVersion";

/**
 * Server-derived tables, derived from `TABLE_KIND` in `db/index.ts`.
 * Type assertion is safe because `TABLE_KIND` is exhaustive over
 * `PtnTableName` via its `satisfies` clause.
 */
const SERVER_DERIVED_TABLES = (
  Object.entries(TABLE_KIND) as [PtnTableName, TableKindValue][]
)
  .filter(([, kind]) => kind === "server-derived")
  .map(([name]) => name);

type TableKindValue = (typeof TABLE_KIND)[PtnTableName];

/** The composite stamp for a given mode. Mode is a PARAM (not a captured
 *  module const) so tests can inject it; production passes the build-time
 *  PATTERN_MODE (frontend-only; resolves to Off under Node/Vitest). */
export function dataSchemaStamp(mode: PatternMode = PATTERN_MODE): string {
  return `${DATA_SCHEMA_VERSION}:${mode}`;
}

/** Raw opaque stamp string from localStorage. NO Number() coercion — a
 *  composite like "1:off" must not be parsed to NaN (which would wipe every
 *  boot). null / empty / throw → treat as unstamped. */
export function getStoredDataSchemaStamp(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null || raw === "" ? null : raw;
  } catch (err) {
    // Without `previous`, the guard cannot distinguish "first install"
    // from "localStorage broken" — both treat the device as unstamped
    // and wipe. Surface so a wipe-every-boot loop is diagnosable
    // instead of mythical.
    reportError(err instanceof Error ? err : new Error(String(err)), {
      context: { source: "dataSchemaGuard.read" },
    });
    return null;
  }
}

function setStoredDataSchemaStamp(v: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch (err) {
    // Swallow but report: a write failure (quota, SecurityError) means
    // the wipe re-runs on every boot, which on metered networks is
    // user-visible. Boot must not depend on persistence.
    reportError(err instanceof Error ? err : new Error(String(err)), {
      context: { source: "dataSchemaGuard.write", version: v },
    });
  }
}

/**
 * Clear every server-derived table. Returns the names of any tables
 * whose `clear()` rejected (excluding tables that don't exist on the
 * current Dexie schema, which is expected on upgrades from older
 * clients). The boot guard uses the failed list to decide whether to
 * stamp the new version.
 */
export async function clearDeployedDataTables(): Promise<{ failed: PtnTableName[] }> {
  const presentTables = new Set(db.tables.map((t) => t.name));
  const targets = SERVER_DERIVED_TABLES.filter((name) => presentTables.has(name));
  const failed: PtnTableName[] = [];

  await Promise.all(
    targets.map(async (name) => {
      try {
        await db[name].clear();
      } catch (err) {
        failed.push(name);
        reportError(err instanceof Error ? err : new Error(String(err)), {
          context: { source: "dataSchemaGuard.clear", table: name },
        });
      }
    }),
  );

  return { failed };
}

export type SchemaGuardResult =
  | { readonly kind: "fresh-install"; readonly previous: null }
  | { readonly kind: "up-to-date"; readonly previous: string }
  | { readonly kind: "wiped"; readonly previous: string }
  | { readonly kind: "wipe-incomplete"; readonly previous: string | null; readonly failed: readonly PtnTableName[] };

export async function ensureDataSchemaUpToDate(
  mode: PatternMode = PATTERN_MODE,
): Promise<SchemaGuardResult> {
  const current = dataSchemaStamp(mode);
  const stored = getStoredDataSchemaStamp();
  if (stored === current) {
    return { kind: "up-to-date", previous: stored };
  }
  const { failed } = await clearDeployedDataTables();
  if (failed.length > 0) {
    // Don't stamp: a future boot retries the wipe so the device
    // doesn't latch into a half-wiped state.
    return { kind: "wipe-incomplete", previous: stored, failed };
  }
  setStoredDataSchemaStamp(current);
  // First-run install (stored === null) is reported separately from a
  // version bump so consumers can distinguish "wiped real data" from
  // "stamped a fresh install".
  return stored === null
    ? { kind: "fresh-install", previous: null }
    : { kind: "wiped", previous: stored };
}
