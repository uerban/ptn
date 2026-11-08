import { db } from "./index.ts";

/** Open and migrate without deleting user data or retained downloads.
 * A version mismatch or blocked upgrade is not evidence of corruption: another
 * tab/build can own a newer connection. Let the caller surface/retry the error.
 * Destructive recovery belongs to the explicit reset action in Settings. */
export async function ensureDbReady(): Promise<{ recovered: boolean }> {
  await db.open();
  await db.gtfsSyncMeta.get("current");
  return { recovered: false };
}
