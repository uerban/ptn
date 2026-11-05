import { db } from "./index.ts";

/**
 * Validates DB is accessible and at expected version.
 * Call before gtfsDataStore.init(). If the DB is corrupted or
 * a migration failed, deletes and recreates the database.
 */
export async function ensureDbReady(): Promise<{ recovered: boolean }> {
  try {
    await db.open();
    // Smoke-test: read from a core table
    await db.gtfsSyncMeta.get("current");
    return { recovered: false };
  } catch (err) {
    const errName = (err as { name?: string } | null)?.name;
    const isCorruption = errName === "VersionError" || errName === "UpgradeBlockedError";
    if (isCorruption) {
      console.error("DB corrupted, deleting for recovery:", err);
      try {
        await db.delete();
        await db.open();
        return { recovered: true };
      } catch (fatal) {
        console.error("IndexedDB recovery failed:", fatal);
        throw fatal;
      }
    } else {
      console.error("DB open failed (non-corruption):", err);
      throw err;
    }
  }
}
