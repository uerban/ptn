import type { RoutingBundleData } from "@pt/shared";
import type { DecodePtbCatalogOptions } from "./ptbCatalogDecode.ts";

type WorkerReply =
  | { ok: true; data: RoutingBundleData }
  | { ok: false; error: string };

let standby: Worker | undefined;
let warmTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const active = new Set<() => void>();
const createWorker = (): Worker => new Worker(new URL("./ptbCatalog.worker.ts", import.meta.url), {type: "module"});
function warmNext(): void {
  if (disposed || standby || warmTimer !== undefined) return;
  warmTimer = setTimeout(() => {
    warmTimer = undefined;
    if (disposed || standby) return;
    try {
      const worker = createWorker();
      standby = worker;
      worker.onerror = () => {
        if (standby === worker) standby = undefined;
        worker.terminate();
      };
    } catch { /* Optional prewarming must not fail an already completed decode. */ }
  }, 0);
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  disposed = true;
  if (warmTimer !== undefined) clearTimeout(warmTimer);
  standby?.terminate();
  standby = undefined;
  for (const cancel of active) cancel();
});

/** Each worker decodes once and is terminated; the standby contains no city data. */
export async function decodePtbCatalogInWorker(
  bytes: Uint8Array,
  options: DecodePtbCatalogOptions,
  signal?: AbortSignal,
): Promise<RoutingBundleData> {
  signal?.throwIfAborted();
  if (typeof Worker === "undefined") {
    const {decodePtbCatalog} = await import("./ptbCatalogDecode.ts");
    signal?.throwIfAborted();
    return decodePtbCatalog(bytes, options);
  }

  return new Promise((resolve, reject) => {
    const worker = standby ?? createWorker();
    standby = undefined;
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      active.delete(cancel);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      warmNext();
      return true;
    };
    const cancel = (): void => {
      if (finish()) reject(signal?.reason ?? new DOMException("Catalog decode cancelled", "AbortError"));
    };
    active.add(cancel);
    signal?.addEventListener("abort", cancel, {once: true});
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (!finish()) return;
      if (event.data.ok) resolve(event.data.data);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      if (finish()) reject(new Error(event.message || "ptb catalog worker failed"));
    };
    try {
      const ownedBytes = bytes.slice().buffer;
      worker.postMessage({bytes: ownedBytes, options}, [ownedBytes]);
    } catch (error) {
      if (finish()) reject(error);
    }
  });
}
