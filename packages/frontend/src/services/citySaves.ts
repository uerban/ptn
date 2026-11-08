import type { BaseEndpoint } from "@pt/shared";
import { db, type SavedLocationRecord } from "../db/index.ts";
import { decrypt, type EncryptedRecord } from "./cryptoBox.ts";
import { getOrCreateInstallKey } from "./installKey.ts";

import { canonicalCityId } from "../utils/cityId.ts";
export { canonicalCityId as canonicalSaveCity } from "../utils/cityId.ts";

/** Indexed selection precedes cloning private values or decrypting endpoints. */
export function listCitySaves(cityId: string): Promise<SavedLocationRecord[]> {
  const id = canonicalCityId(cityId);
  return db.savedLocations.where("cityId").anyOf(id === "tricity" ? [id, "gdansk"] : [id]).toArray();
}

export interface ResolvedSave {
  id: string;
  alias: string;
  origin: BaseEndpoint;
  destination?: BaseEndpoint;
  savedAt: number;
}

export async function resolveSaves(rows: SavedLocationRecord[]): Promise<ResolvedSave[]> {
  const sorted = [...rows].sort((a, b) => b.savedAt - a.savedAt);
  const key = sorted.some(row => row.encrypted || row.aliasCipher)
    ? await getOrCreateInstallKey().catch(() => null) : null;
  const out: ResolvedSave[] = [];
  for (const row of sorted) {
    try {
      if ((row.encrypted || row.aliasCipher) && !key) continue;
      const origin = row.encrypted ? await decrypt(row.endpoint as EncryptedRecord, key!) as BaseEndpoint : row.endpoint as BaseEndpoint;
      const destination = row.destinationEndpoint === undefined ? undefined
        : row.encrypted ? await decrypt(row.destinationEndpoint as EncryptedRecord, key!) as BaseEndpoint : row.destinationEndpoint as BaseEndpoint;
      const alias = row.aliasCipher ? await decrypt(row.aliasCipher, key!) as string : row.alias;
      out.push({id: row.id, alias, origin, destination, savedAt: row.savedAt});
    } catch { /* An unreadable record remains stored for recovery; never overwrite it. */ }
  }
  return out;
}

/** Explicit recovery action. Never relabel a record that already has an owner. */
export async function assignSavedCity(id: string, cityId: string): Promise<void> {
  await db.transaction("rw", db.savedLocations, async () => {
    const row = await db.savedLocations.get(id);
    if (row && !row.cityId) await db.savedLocations.update(id, {cityId: canonicalCityId(cityId)});
  });
}
