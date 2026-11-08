import Dexie, {type Table} from "dexie";
import { db } from "../db/index.ts";

/** Abort rolls back the entire projection, including requests already queued
 * in IndexedDB. A post-await generation check alone cannot protect disk state. */
export async function cityDataWrite<T>(tables: Table[], signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  return db.transaction("rw", tables, async () => {
    const transaction = Dexie.currentTransaction!;
    const abort = () => transaction.abort();
    signal?.addEventListener("abort", abort, {once: true});
    try {
      signal?.throwIfAborted();
      const result = await work();
      signal?.throwIfAborted();
      return result;
    } finally { signal?.removeEventListener("abort", abort); }
  });
}
