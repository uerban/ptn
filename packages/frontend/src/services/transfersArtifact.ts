import { decode as decodeTransfers, type DecodedTransfers } from "@pt/shared/transfers";

/**
 * Fetch the pre-computed pedestrian transfers artifact bytes served by the
 * backend at `meta.transfersArtifact.url`, verifying SHA-256 against the
 * manifest's `expectedHash`. The browser handles `Content-Encoding: gzip`
 * transparently, so we receive the raw PTFT bytes.
 *
 * Returns raw bytes — callers that want the decoded `Transfers` shape use
 * `fetchTransfersArtifact`; callers that need to pass the bytes through an
 * opaque boundary (the wasm engine's `PtRouter.setTransfers`) use this.
 */
export async function fetchTransfersArtifactBytes(
  url: string,
  expectedHash: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const absolute = new URL(url, window.location.origin).toString();
  // F9: callers key the signal to the city/init generation so a city switch
  // mid-download aborts the transfer instead of resolving into stale state.
  const res = await fetch(absolute, { signal: opts.signal });
  if (!res.ok) {
    throw new Error(`transfers artifact HTTP ${res.status} for ${url}`);
  }
  const buffer = await res.arrayBuffer();
  const hash = await sha256Hex(buffer);
  if (hash !== expectedHash) {
    // Truncate hash for grep brevity; full values would dominate the log line.
    throw new Error(
      `transfers artifact hash mismatch for ${url}: got ${hash.slice(0, 8)}…, expected ${expectedHash.slice(0, 8)}…`,
    );
  }
  return new Uint8Array(buffer);
}

/**
 * Fetch and decode the pre-computed pedestrian transfers artifact. Thin
 * wrapper over `fetchTransfersArtifactBytes` for the TS-engine read path
 * (`raptorIndex.loadFootTransfers`).
 */
export async function fetchTransfersArtifact(
  url: string,
  expectedHash: string,
  opts: { signal?: AbortSignal } = {},
): Promise<DecodedTransfers> {
  const bytes = await fetchTransfersArtifactBytes(url, expectedHash, opts);
  return decodeTransfers(bytes);
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
