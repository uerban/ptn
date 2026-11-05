import {describe, expect, it, vi} from "vitest";
import {discoverWalkGraph, fetchWalkGraphBytes} from "./walkGraphResource.ts";

async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
}
async function repository(options: {status?: string; city?: string} = {}) {
  const bytes = new Uint8Array([1, 2, 3]);
  const component = options.status ? {status: options.status, reason: "node cap"} : {
    status: "present", format: "ptwg", formatVersion: 2, compression: "brotli",
    sha256: await hash(bytes), bytes: bytes.length, decodedBytes: 100,
  };
  const manifest = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1, city: options.city ?? "oslo", components: {walkGraph: component},
  }));
  const release = await hash(manifest);
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (url === "/osm/current/oslo.json") return Response.json({schemaVersion: 1, release, revision: 7});
    if (url === `/osm/releases/${release}/manifest.json`) return new Response(manifest);
    if (url === `/osm/releases/${release}/walk-graph.ptwg.br`) return new Response(bytes);
    return new Response(null, {status: 404});
  });
  return {bytes, release, fetcher};
}

describe("installed walk graph discovery", () => {
  it("pins one activation and verifies immutable compressed bytes", async () => {
    const {bytes, release, fetcher} = await repository();
    const discovered = await discoverWalkGraph("oslo", fetcher);
    expect(discovered.kind).toBe("present");
    if (discovered.kind !== "present") throw new Error("missing resource");
    expect(discovered.resource).toMatchObject({release, revision: 7, cityId: "oslo"});
    expect(new Uint8Array(await fetchWalkGraphBytes(discovered.resource, fetcher))).toEqual(bytes);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/osm/current/oslo.json", `/osm/releases/${release}/manifest.json`,
      `/osm/releases/${release}/walk-graph.ptwg.br`,
    ]);
  });
  it.each(["unsupported", "failed"])("represents an explicitly %s graph without fetching bytes", async status => {
    const {fetcher, release} = await repository({status});
    expect(await discoverWalkGraph("oslo", fetcher)).toEqual({kind: "unavailable", release, revision: 7});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects manifest tampering and cross-city manifests", async () => {
    const first = await repository();
    first.fetcher.mockResolvedValueOnce(Response.json({schemaVersion: 1, release: first.release, revision: 7}));
    first.fetcher.mockResolvedValueOnce(Response.json({schemaVersion: 1, city: "oslo"}));
    await expect(discoverWalkGraph("oslo", first.fetcher)).rejects.toThrow("checksum");
    const second = await repository({city: "vilnius"});
    await expect(discoverWalkGraph("oslo", second.fetcher)).rejects.toThrow("city/schema");
  });
  it("rejects corrupt, oversized, transformed and redirected resources", async () => {
    const {fetcher} = await repository();
    const discovered = await discoverWalkGraph("oslo", fetcher);
    if (discovered.kind !== "present") throw new Error("missing resource");
    for (const response of [
      new Response(new Uint8Array([3, 2, 1])),
      new Response(new Uint8Array(4)),
      new Response(new Uint8Array([1, 2, 3]), {headers: {"content-encoding": "br"}}),
    ]) {
      const corrupt = vi.fn(async () => response);
      await expect(fetchWalkGraphBytes(discovered.resource, corrupt)).rejects.toThrow();
    }
    await expect(fetchWalkGraphBytes({
      ...discovered.resource, url: "https://other.example/graph.br",
    }, fetcher)).rejects.toThrow("invalid");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects unsafe cities before any request and preserves network failures as failures", async () => {
    const fetcher = vi.fn(async () => {throw new Error("offline");});
    await expect(discoverWalkGraph("../oslo", fetcher)).rejects.toThrow("invalid");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(discoverWalkGraph("oslo", fetcher)).rejects.toThrow("offline");
  });
});
