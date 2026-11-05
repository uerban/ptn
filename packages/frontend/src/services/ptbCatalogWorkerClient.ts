import type { RoutingBundleData } from "@pt/shared";
import type { DecodePtbCatalogOptions } from "./ptbCatalogDecode.ts";

type WorkerReply =
  | { ok: true; data: RoutingBundleData }
  | { ok: false; error: string };

/**
 * Decode off the main thread on production browsers. The direct path keeps the
 * pure decoder usable in SSR/jsdom and older embedded browsers without Worker.
 */
export function decodePtbCatalogInWorker(
  bytes: Uint8Array,
  options: DecodePtbCatalogOptions,
): Promise<RoutingBundleData> {
  if (typeof Worker === "undefined") {
    return import("./ptbCatalogDecode.ts").then(({ decodePtbCatalog }) =>
      decodePtbCatalog(bytes, options));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./ptbCatalog.worker.ts", import.meta.url), { type: "module" });
    const ownedBytes = bytes.slice().buffer;

    const finish = (): void => worker.terminate();
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      finish();
      if (event.data.ok) resolve(event.data.data);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "ptb catalog worker failed"));
    };
    worker.postMessage({ bytes: ownedBytes, options }, [ownedBytes]);
  });
}
