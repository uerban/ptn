import { db } from "../db/index.ts";
import { registerEvictor } from "./storagePolicy.ts";
import { reportError } from "./errorReporter.ts";
import { noteTileCacheCleared } from "./scheduleTileCache.ts";

async function clearAll(): Promise<void> {
  try {
    await db.scheduleTileCache.clear();
    // Keep the tile cache's running byte total (F6) in sync with the wipe.
    noteTileCacheCleared();
  } catch (e) {
    reportError(e instanceof Error ? e : new Error(String(e)), {
      context: { source: "scheduleTileEvictor.clearAll" },
    });
  }
}

export function registerScheduleTileEvictor(): void {
  registerEvictor("scheduleTileCache", clearAll);
}
