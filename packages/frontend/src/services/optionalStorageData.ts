import { db } from "../db/index.ts";
import { useDelayReportStore } from "../stores/delayReportStore.ts";
import { clearErrorBuffer } from "./errorReporter.ts";
import { clearRecents } from "./recents.ts";
import { clearPersonal } from "./personalStorage.ts";
import { mapViewportItem, removeSealedItem } from "./sealedLocalStorage.ts";
import { DELAY_REPORTS_STORAGE_KEY } from "./privacyStorageKeys.ts";

export async function clearRecentsData(): Promise<void> {
  await clearRecents();
}

export async function clearViewportData(
  storage?: Pick<Storage, "removeItem">,
): Promise<void> {
  mapViewportItem.remove(storage ?? globalThis.localStorage);
}

export async function clearPersonalizationData(): Promise<void> {
  await clearPersonal("personalUsage");
  // Rows from before stop use was sealed, if a conversion is still pending.
  await Promise.all([db.usageStats.clear(), db.cityUsageStats.clear()]);
}

export async function clearLocalReportsData(
  storage?: Pick<Storage, "removeItem">,
): Promise<void> {
  useDelayReportStore.setState({ reports: [] });
  removeSealedItem(DELAY_REPORTS_STORAGE_KEY, storage ?? globalThis.localStorage);
  clearErrorBuffer();
}

/** Cached third-party search results (keyed by an install-keyed HMAC). */
export async function clearSearchCacheData(): Promise<void> {
  await db.geocoderDedup.clear();
}
