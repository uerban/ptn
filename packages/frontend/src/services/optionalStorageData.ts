import { db } from "../db/index.ts";
import { useDelayReportStore } from "../stores/delayReportStore.ts";
import { clearErrorBuffer } from "./errorReporter.ts";
import { clearRecents } from "./recents.ts";
import {
  DELAY_REPORTS_STORAGE_KEY,
  MAP_VIEWPORT_STORAGE_KEY,
} from "./privacyStorageKeys.ts";

export async function clearRecentsData(): Promise<void> {
  await clearRecents();
}

export async function clearViewportData(
  storage?: Pick<Storage, "removeItem">,
): Promise<void> {
  (storage ?? globalThis.localStorage)?.removeItem(MAP_VIEWPORT_STORAGE_KEY);
}

export async function clearPersonalizationData(): Promise<void> {
  await db.usageStats.clear();
}

export async function clearLocalReportsData(
  storage?: Pick<Storage, "removeItem">,
): Promise<void> {
  useDelayReportStore.setState({ reports: [] });
  (storage ?? globalThis.localStorage)?.removeItem(DELAY_REPORTS_STORAGE_KEY);
  clearErrorBuffer();
}
