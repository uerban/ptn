/** A small worker-safe IndexedDB store. Avoid importing the application's Dexie
 * database (and its migrations) into the dedicated graph worker. */
import type {WalkGraphResource} from "./walkGraphResource.ts";
export interface WalkGraphArtifactRecord {
  cityId: string;
  resource: WalkGraphResource;
  compressed: ArrayBuffer;
  installedAt: number;
}
export const WALK_GRAPH_DATABASE = "ptn-walk-graphs";

export function openWalkGraphStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WALK_GRAPH_DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("graphs", {keyPath: "cityId"})
        .createIndex("installedAt", "installedAt");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transaction<T>(mode: IDBTransactionMode,
  work: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  const database = await openWalkGraphStore();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction("graphs", mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error("graph cache transaction aborted"));
      tx.onerror = () => {}; // The abort event reports failure after rollback.
      try {work(tx.objectStore("graphs"), next => {value = next;});}
      catch (error) {tx.abort(); reject(error);}
    });
  } finally {database.close();}
}

export function clearWalkGraphStore(): Promise<void> {
  return transaction<void>("readwrite", store => {store.clear();});
}
export function getStoredWalkGraph(cityId: string): Promise<WalkGraphArtifactRecord | undefined> {
  return transaction("readonly", (store, result) => {
    store.get(cityId).onsuccess = event => result((event.target as IDBRequest).result);
  });
}

/** Check revision, replace bytes and prune keys in one cross-tab transaction.
 * Cursor keys avoid materializing other cities' compressed graph bodies. */
export function putStoredWalkGraph(record: WalkGraphArtifactRecord): Promise<boolean> {
  return transaction("readwrite", (store, result) => {
    const previous = store.get(record.cityId);
    previous.onsuccess = () => {
      const old = previous.result as WalkGraphArtifactRecord | undefined;
      if (old && (old.resource.revision > record.resource.revision ||
          (old.resource.revision === record.resource.revision && old.resource.release !== record.resource.release))) {
        result(false); return;
      }
      store.put(record);
      const keys: IDBValidKey[] = [];
      const cursor = store.index("installedAt").openKeyCursor();
      cursor.onsuccess = () => {
        if (cursor.result) {
          keys.push(cursor.result.primaryKey); cursor.result.continue(); return;
        }
        for (const key of keys.filter(key => key !== record.cityId).slice(0, Math.max(0, keys.length - 4))) store.delete(key);
        result(true);
      };
    };
  });
}
