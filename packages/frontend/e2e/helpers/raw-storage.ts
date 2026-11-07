import type { Page } from "@playwright/test";

/**
 * What a person inspecting the browser profile would see: every row of the
 * given IndexedDB object stores (binary fields decoded as text so a plaintext
 * label inside a buffer still shows) and every localStorage value.
 */
export async function rawStorageDump(
  page: Page,
  stores: readonly string[] = [
    "recentLocations",
    "savedLocations",
    "personalUsage",
    "usageStats",
    "geocoderDedup",
  ],
): Promise<string> {
  return await page.evaluate(async (storeNames) => {
    const decode = (v: unknown): unknown => {
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
        const bytes =
          v instanceof ArrayBuffer
            ? new Uint8Array(v)
            : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      }
      return v;
    };
    const idb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("ptn");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const parts: string[] = [];
    for (const name of storeNames) {
      if (!idb.objectStoreNames.contains(name)) continue;
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const r = idb.transaction(name, "readonly").objectStore(name).getAll();
        r.onsuccess = () => resolve(r.result as unknown[]);
        r.onerror = () => reject(r.error);
      });
      parts.push(`${name}=${JSON.stringify(rows, (_k, v: unknown) => decode(v))}`);
    }
    idb.close();
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) parts.push(`${key}=${localStorage.getItem(key) ?? ""}`);
    }
    return parts.join("\n");
  }, stores);
}

/** The top-level field names of every row in an object store. */
export async function rowShapes(page: Page, store: string): Promise<string[][]> {
  return await page.evaluate(async (name) => {
    const idb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("ptn");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const r = idb.transaction(name, "readonly").objectStore(name).getAll();
      r.onsuccess = () => resolve(r.result as Record<string, unknown>[]);
      r.onerror = () => reject(r.error);
    });
    idb.close();
    return rows.map((row) => Object.keys(row).sort());
  }, store);
}
