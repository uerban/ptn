import {beforeEach, afterEach, expect, it, vi} from "vitest";
import {createHash, webcrypto} from "node:crypto";
import {db} from "../db/index.ts";
import {fetchTransfersArtifactBytes, clearTransferArtifactMemory, ensureTransferArtifactStored} from "./transfersArtifact.ts";
const bytes = new Uint8Array([1, 2, 3]);
const hash = createHash("sha256").update(bytes).digest("hex");
beforeEach(async () => {clearTransferArtifactMemory(); await db.open(); await db.offlineTransfers.clear(); vi.stubGlobal("crypto", webcrypto);});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});
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

it("returns verified bytes while persistence is stalled; explicit pinning waits", async () => {
  const Dexie = (await import("dexie")).default;
  let finish!: () => void;
  const nativePut = db.offlineTransfers.put.bind(db.offlineTransfers);
  const held = new Dexie.Promise<string>(resolve => {finish = () => resolve(hash);});
  vi.spyOn(db, "transaction").mockReturnValueOnce(held);
  const fetcher = vi.fn().mockResolvedValue(new Response(bytes)); vi.stubGlobal("fetch", fetcher);
  expect([...await fetchTransfersArtifactBytes("/transfers", hash)]).toEqual([...bytes]);
  expect([...await fetchTransfersArtifactBytes("/transfers", hash)]).toEqual([...bytes]);
  expect(fetcher).toHaveBeenCalledOnce();
  let pinned = false;
  const wait = ensureTransferArtifactStored(hash).then(() => {pinned = true;});
  await Promise.resolve();
  expect(pinned).toBe(false);
  await nativePut({hash, bytes});
  finish();
  await wait;
  expect(pinned).toBe(true);
});

it("shares concurrent reads and does not publish an abandoned fetch after cache removal", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockReturnValue(new Promise(resolve => {finish = resolve;}));
  vi.stubGlobal("fetch", fetcher);
  const a = fetchTransfersArtifactBytes("/transfers", hash);
  const b = fetchTransfersArtifactBytes("/transfers", hash);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  clearTransferArtifactMemory();
  finish(new Response(bytes));
  expect([...await a]).toEqual([...bytes]);
  expect([...await b]).toEqual([...bytes]);
  expect(await db.offlineTransfers.get(hash)).toBeUndefined();
});

it("does not certify a corrupt retained transfer as a completed offline download", async () => {
  await db.offlineTransfers.put({hash, bytes: new Uint8Array([9])});
  await expect(ensureTransferArtifactStored(hash)).rejects.toThrow("not verified");
});

it("can repair a removed durable copy from verified resident bytes during explicit pinning", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(bytes)); vi.stubGlobal("fetch", fetcher);
  await fetchTransfersArtifactBytes("/transfers", hash);
  await ensureTransferArtifactStored(hash);
  await db.offlineTransfers.delete(hash);
  await ensureTransferArtifactStored(hash);
  expect(Array.from((await db.offlineTransfers.get(hash))!.bytes)).toEqual(Array.from(bytes));
  expect(fetcher).toHaveBeenCalledOnce();
});
