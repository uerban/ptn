import {beforeEach, afterEach, expect, it, vi} from "vitest";
import {createHash, webcrypto} from "node:crypto";
import {db} from "../db/index.ts";
import {fetchTransfersArtifactBytes} from "./transfersArtifact.ts";
const bytes = new Uint8Array([1, 2, 3]);
const hash = createHash("sha256").update(bytes).digest("hex");
beforeEach(async () => {await db.open(); await db.offlineTransfers.clear(); vi.stubGlobal("crypto", webcrypto);});
afterEach(() => vi.unstubAllGlobals());
it("stores verified bytes and reuses them without a network request", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(bytes)); vi.stubGlobal("fetch", fetcher);
  expect([...await fetchTransfersArtifactBytes("/transfers", hash)]).toEqual([...bytes]);
  fetcher.mockRejectedValue(new Error("offline"));
  expect([...await fetchTransfersArtifactBytes("/transfers", hash)]).toEqual([...bytes]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not trust corrupt cached bytes or cache a corrupt server response", async () => {
  await db.offlineTransfers.put({hash, bytes: new Uint8Array([9])});
  const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([8]))); vi.stubGlobal("fetch", fetcher);
  await expect(fetchTransfersArtifactBytes("/transfers", hash)).rejects.toThrow("hash mismatch");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
