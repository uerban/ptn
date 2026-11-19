import { expect, it, vi } from "vitest";
import { createWalkGraphHost } from "./walkGraphWorkerHost.ts";
import type { WalkGraphResource } from "./walkGraphResource.ts";
import type { WalkGraphCandidate } from "./walkGraphOffline.ts";

function candidate(size: number, hash: string): WalkGraphCandidate {
  return { compressed: new Uint8Array([7]).buffer, resource: {
    cityId: "oslo", release: "a".repeat(64), revision: 1,
    url: `/osm/releases/${"a".repeat(64)}/walk-graph.ptwg.br`,
    sha256: hash.repeat(64), bytes: 1, decodedBytes: size,
  } satisfies WalkGraphResource };
}
it("passes each managed candidate's own decoded bound, including the last-good fallback", async () => {
  const fresh = candidate(8, "b"), old = candidate(9, "c");
  const decompress = vi.fn().mockRejectedValueOnce(new Error("output limit"))
    .mockResolvedValueOnce(new Uint8Array(9));
  const remember = vi.fn(async () => {});
  const host = createWalkGraphHost({
    fetch: vi.fn(),
    artifacts: { load: async () => fresh, fallback: async () => old, remember },
    decompress,
    loadModule: async () => ({ default: async () => {}, PtWalkGraph: class {
      cityId() { return "oslo"; }
      route() { return null; }
      free() {}
    } }),
  });
  try {
    expect(await host.handle({ id: 1, op: "load", cityId: "oslo" })).toMatchObject({ status: "ready" });
    expect(decompress.mock.calls.map(([, limit]) => limit)).toEqual([8, 9]);
    expect(remember).toHaveBeenCalledWith(old);
  } finally { host.dispose(); }
});
