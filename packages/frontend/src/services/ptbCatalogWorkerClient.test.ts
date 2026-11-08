import {afterEach, beforeEach, expect, it, vi} from "vitest";
import type {DecodePtbCatalogOptions} from "./ptbCatalogDecode.ts";
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn<(message: {bytes: ArrayBuffer}, transfer: ArrayBuffer[]) => void>();
  constructor() { FakeWorker.instances.push(this); }
}
const options = {cityId: "test", generation: {generationId: "one"}} as DecodePtbCatalogOptions;
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); FakeWorker.instances = []; vi.stubGlobal("Worker", FakeWorker); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("transfers a copy and reuses only an empty prestarted worker", async () => {
  const {decodePtbCatalogInWorker: decode} = await import("./ptbCatalogWorkerClient.ts");
  const bytes = new Uint8Array([1, 2, 3]);
  const result = decode(bytes, options);
  const first = FakeWorker.instances[0];
  const [message, transfer] = first.postMessage.mock.calls[0];
  expect(message.bytes).not.toBe(bytes.buffer);
  expect(new Uint8Array(message.bytes)).toEqual(bytes);
  expect(transfer).toEqual([message.bytes]);
  first.onmessage!({data: {ok: true, data: {stops: []}}} as MessageEvent);
  await expect(result).resolves.toEqual({stops: []});
  expect(first.terminate).toHaveBeenCalledOnce();
  await vi.runOnlyPendingTimersAsync();
  const empty = FakeWorker.instances[1];
  expect(empty.postMessage).not.toHaveBeenCalled();
  const next = decode(bytes, options);
  expect(FakeWorker.instances).toHaveLength(2);
  empty.onmessage!({data: {ok: true, data: {stops: []}}} as MessageEvent);
  await next;
  expect(empty.terminate).toHaveBeenCalledOnce();
});
it("does not create a worker for pre-aborted work", async () => {
  const {decodePtbCatalogInWorker: decode} = await import("./ptbCatalogWorkerClient.ts");
  const controller = new AbortController(); controller.abort();
  await expect(decode(new Uint8Array(), options, controller.signal)).rejects.toMatchObject({name: "AbortError"});
  expect(FakeWorker.instances).toHaveLength(0);
});
it("terminates aborted work and ignores an already queued reply", async () => {
  const {decodePtbCatalogInWorker: decode} = await import("./ptbCatalogWorkerClient.ts");
  const controller = new AbortController();
  const result = decode(new Uint8Array(), options, controller.signal);
  const worker = FakeWorker.instances[0];
  const queued = worker.onmessage!;
  controller.abort();
  queued({data: {ok: true, data: {}}} as MessageEvent);
  await expect(result).rejects.toMatchObject({name: "AbortError"});
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.onmessage).toBeNull();
});
it("cleans up worker and transfer errors", async () => {
  const {decodePtbCatalogInWorker: decode} = await import("./ptbCatalogWorkerClient.ts");
  const result = decode(new Uint8Array(), options);
  FakeWorker.instances[0].onerror!({message: "decode failed"} as ErrorEvent);
  await expect(result).rejects.toThrow("decode failed");
  await vi.runOnlyPendingTimersAsync();
  FakeWorker.instances[1].postMessage.mockImplementation(() => { throw new Error("clone failed"); });
  await expect(decode(new Uint8Array(), options)).rejects.toThrow("clone failed");
  expect(FakeWorker.instances[1].terminate).toHaveBeenCalledOnce();
});
