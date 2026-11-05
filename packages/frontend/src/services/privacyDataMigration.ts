import {
  clearLocalReportsData,
  clearPersonalizationData,
  clearRecentsData,
  clearViewportData,
} from "./optionalStorageData.ts";
import {
  PRIVACY_DATA_MIGRATION_KEY,
  PRIVACY_DATA_MIGRATION_VERSION,
  isPrivacyDataMigrationComplete,
} from "./privacyDataMigrationState.ts";

export interface PrivacyDataMigrationActions {
  clearRecents: () => Promise<void>;
  clearUsageStats: () => Promise<void>;
  clearViewport: () => Promise<void>;
  clearLocalReports: () => Promise<void>;
}

export interface PrivacyDataMigrationOptions {
  storage?: Pick<Storage, "getItem" | "setItem">;
  actions?: PrivacyDataMigrationActions;
}

export type PrivacyDataMigrationResult = "already-complete" | "migrated";

const DEFAULT_ACTIONS: PrivacyDataMigrationActions = {
  clearRecents: clearRecentsData,
  clearUsageStats: clearPersonalizationData,
  clearViewport: clearViewportData,
  clearLocalReports: clearLocalReportsData,
};

/**
 * Removes history written before optional-storage choices existed. Saved
 * places/journeys, settings, accessibility choices, and public downloads are
 * deliberately outside this migration. The marker is committed last so any
 * partial failure retries idempotently on the next launch.
 */
export async function runPrivacyDataMigration(
  opts: PrivacyDataMigrationOptions = {},
): Promise<PrivacyDataMigrationResult> {
  const storage = opts.storage ?? globalThis.localStorage;
  if (isPrivacyDataMigrationComplete(storage)) return "already-complete";

  const actions = opts.actions ?? DEFAULT_ACTIONS;
  await actions.clearRecents();
  await actions.clearUsageStats();
  await actions.clearViewport();
  await actions.clearLocalReports();
  storage.setItem(PRIVACY_DATA_MIGRATION_KEY, PRIVACY_DATA_MIGRATION_VERSION);
  return "migrated";
}
