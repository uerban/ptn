import { decodePtbCatalog, type DecodePtbCatalogOptions } from "./ptbCatalogDecode.ts";

interface DecodeRequest {
  bytes: ArrayBuffer;
  options: DecodePtbCatalogOptions;
}

type WorkerScope = {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: unknown): void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  try {
    const data = decodePtbCatalog(new Uint8Array(event.data.bytes), event.data.options);
    scope.postMessage({ ok: true, data });
  } catch (error) {
    scope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
