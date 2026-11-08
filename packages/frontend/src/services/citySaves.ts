import { assignSaveCity, listCitySaves as listSealedCitySaves, listSaves, type ResolvedSave } from "./saves.ts";

export { canonicalCityId as canonicalSaveCity } from "../utils/cityId.ts";
export type { ResolvedSave } from "./saves.ts";

/**
 * Saves owned by `cityId`, newest first. City ownership is sealed with each
 * save, so this decrypts and then filters; no plaintext city index exists.
 */
export function listCitySaves(cityId: string): Promise<ResolvedSave[]> {
  return listSealedCitySaves(cityId);
}

/** Readable legacy saves that have no city yet, newest first. */
export async function listUnassignedSaves(): Promise<ResolvedSave[]> {
  return (await listSaves()).filter((save) => !save.cityId);
}

/** Explicit recovery action. Never relabel a record that already has an owner. */
export async function assignSavedCity(id: string, cityId: string): Promise<void> {
  await assignSaveCity(id, cityId);
}
