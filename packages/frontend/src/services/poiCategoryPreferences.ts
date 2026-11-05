import { useSettingsStore } from "../stores/settingsStore.ts";
import type { PoiIndexRecord } from "../db/index.ts";

/** Apply at read time so cached/offline rows obey preference changes immediately.
 * Strict landmarks are always available, including curated schools. */
export function isPoiCategoryEnabled(record: Pick<PoiIndexRecord, "tier" | "category">): boolean {
  if (record.tier !== "loose") return true;
  const { poiLooseCategories } = useSettingsStore.getState();
  return poiLooseCategories.some((category) => category === record.category);
}
