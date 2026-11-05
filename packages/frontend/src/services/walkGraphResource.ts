/** Browser discovery for manager-installed PTWG releases. The same-origin
 * installation is authenticated by the manager; exact hashes bind each fetch to
 * the activation snapshot, even if the deployment pointer changes meanwhile. */
const SHA256 = /^[0-9a-f]{64}$/;
const CITY = /^[a-z][a-z0-9-]{0,63}$/;
const METADATA_CAP = 1024 * 1024;
const GRAPH_CAP = 64 * 1024 * 1024;
const DECODED_CAP = 256 * 1024 * 1024;

export interface WalkGraphResource {
  cityId: string;
  release: string;
  revision: number;
  url: string;
  sha256: string;
  bytes: number;
  decodedBytes: number;
}

export type WalkGraphDiscovery =
  | {kind: "present"; resource: WalkGraphResource}
  | {kind: "unavailable"; release?: string; revision?: number};

export async function boundedResponseBytes(response: Response, cap: number): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("artifact response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > cap) throw new Error("artifact response exceeds byte limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const buffer = new ArrayBuffer(length);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return buffer;
}

export async function artifactSha256(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid artifact metadata");
  return value as Record<string, unknown>;
}
function positiveSize(value: unknown, cap: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= cap;
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

/** Read activation once; derive every subsequent URL from its immutable hash. */
export async function discoverWalkGraph(
  cityId: string, fetcher: typeof fetch = fetch, signal?: AbortSignal,
): Promise<WalkGraphDiscovery> {
  if (!CITY.test(cityId)) throw new Error("invalid walk graph city");
  const options: RequestInit = {
    signal, cache: "no-cache", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
  };
  const activationResponse = await fetcher(`/osm/current/${cityId}.json`, options);
  if (activationResponse.status === 404) return {kind: "unavailable"};
  if (!activationResponse.ok) throw new Error(`artifact discovery HTTP ${activationResponse.status}`);
  const activation = object(JSON.parse(new TextDecoder().decode(
    await boundedResponseBytes(activationResponse, METADATA_CAP))));
  if (activation.schemaVersion !== 1 || !validHash(activation.release) ||
      !positiveSize(activation.revision, Number.MAX_SAFE_INTEGER)) throw new Error("invalid artifact activation");
  const {release, revision} = activation;
  const manifestResponse = await fetcher(`/osm/releases/${release}/manifest.json`, options);
  if (!manifestResponse.ok) throw new Error(`artifact manifest HTTP ${manifestResponse.status}`);
  const manifestBytes = await boundedResponseBytes(manifestResponse, METADATA_CAP);
  if (await artifactSha256(manifestBytes) !== release) throw new Error("artifact manifest checksum mismatch");
  const manifest = object(JSON.parse(new TextDecoder().decode(manifestBytes)));
  if (manifest.schemaVersion !== 1 || manifest.city !== cityId) throw new Error("artifact manifest city/schema mismatch");
  const graph = object(object(manifest.components).walkGraph);
  if ((graph.status === "unsupported" || graph.status === "failed") &&
      typeof graph.reason === "string" && graph.reason.length > 0) return {kind: "unavailable", release, revision};
  if (graph.status !== "present" || graph.format !== "ptwg" ||
      graph.formatVersion !== 2 || graph.compression !== "brotli" || !validHash(graph.sha256) ||
      !positiveSize(graph.bytes, GRAPH_CAP) || !positiveSize(graph.decodedBytes, DECODED_CAP)) {
    throw new Error("invalid walk graph component");
  }
  return {kind: "present", resource: {
    cityId, release, revision, url: `/osm/releases/${release}/walk-graph.ptwg.br`,
    sha256: graph.sha256, bytes: graph.bytes, decodedBytes: graph.decodedBytes,
  }};
}

/** PTWG is opaque Brotli, never HTTP Content-Encoding. Verify compressed bytes
 * before decoding; native validation still decides whether the graph is usable. */
export async function fetchWalkGraphBytes(
  resource: WalkGraphResource, fetcher: typeof fetch = fetch, signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!CITY.test(resource.cityId) || !validHash(resource.release) || !validHash(resource.sha256) ||
      resource.url !== `/osm/releases/${resource.release}/walk-graph.ptwg.br` ||
      !positiveSize(resource.bytes, GRAPH_CAP) || !positiveSize(resource.decodedBytes, DECODED_CAP)) {
    throw new Error("invalid walk graph resource");
  }
  const response = await fetcher(resource.url, {
    signal, cache: "force-cache", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
  });
  if (!response.ok) throw new Error(`walk graph HTTP ${response.status}`);
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding !== "identity") throw new Error("walk graph must use opaque Brotli");
  const bytes = await boundedResponseBytes(response, resource.bytes);
  if (bytes.byteLength !== resource.bytes || await artifactSha256(bytes) !== resource.sha256) {
    throw new Error("walk graph checksum/size mismatch");
  }
  return bytes;
}
