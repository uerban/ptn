import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RaptorQuery } from "@pt/shared";
import {
  createPtRouterHost,
  type PtRouterReply,
  type PtRouterRequest,
  type PtWasmModule,
} from "./ptRouterWorkerHost.ts";

const ptRouterCtorMock = vi.fn();
const ptRouterPlanMock = vi.fn();
const ptRouterResolveTimeMock = vi.fn();
const ptRouterSetTransfersMock = vi.fn();
const wasmInitMock = vi.fn();

class FakePtRouter {
  constructor(bytes: Uint8Array, mode: string) { ptRouterCtorMock(bytes, mode); }
  plan(q: unknown): unknown { return ptRouterPlanMock(q); }
  resolveTime(t: number): unknown { return ptRouterResolveTimeMock(t); }
  setTransfers(bytes: Uint8Array): void { ptRouterSetTransfersMock(bytes); }
  free(): void {}
  isAlive(): boolean { return true; }
}

vi.mock("@pt/wasm", () => ({
  PtRouter: FakePtRouter,
  default: (...args: unknown[]) => wasmInitMock(...args),
}));

import {
  buildPtRouter,
  planWithWasm,
  PtWasmImportError,
  PtWasmInitError,
  PtWasmQueryError,
  PtWasmTimeError,
  PtWasmTransfersError,
} from "./raptorWasm.ts";

/**
 * Stand-in for the dedicated worker: runs the real request handler, and
 * crosses the boundary with `structuredClone` + the transfer list so a reply
 * that would not survive `postMessage`, or a buffer the client still needed
 * after transferring it, fails here as it would in a browser.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static loadWasm: () => Promise<PtWasmModule> = () => import("@pt/wasm") as Promise<PtWasmModule>;
  onmessage: ((event: MessageEvent<PtRouterReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  readonly url: string;
  readonly received: PtRouterRequest[] = [];
  private readonly handle = createPtRouterHost(FakeWorker.loadWasm);

  constructor(url: URL | string) {
    this.url = String(url);
    FakeWorker.instances.push(this);
  }

  postMessage(message: PtRouterRequest, transfer: Transferable[] = []): void {
    if (this.terminated) return;
    const received = structuredClone(message, { transfer });
    this.received.push(received);
    void this.handle(received).then((reply) => {
      if (!this.terminated) this.onmessage?.({ data: structuredClone(reply) } as MessageEvent<PtRouterReply>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  crash(message: string): void {
    this.onerror?.({ message, preventDefault: () => {} } as unknown as ErrorEvent);
  }
}

const QUERY = {
  entryStops: [{ stopId: "S1", walkSecs: 0 }],
  exitStops: [{ stopId: "S2", walkSecs: 0 }],
  departureSecs: 0,
} as unknown as RaptorQuery;

const latestWorker = (): FakeWorker => FakeWorker.instances[FakeWorker.instances.length - 1]!;

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.loadWasm = () => import("@pt/wasm") as Promise<PtWasmModule>;
  ptRouterCtorMock.mockReset();
  ptRouterPlanMock.mockReset();
  ptRouterResolveTimeMock.mockReset();
  ptRouterSetTransfersMock.mockReset();
  wasmInitMock.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("Worker", FakeWorker);
  performance.clearMarks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildPtRouter on the worker path", () => {
  it("builds the router in a worker and plans through it", async () => {
    const itinerary = { legs: [], departureSecs: 60, arrivalSecs: 600 };
    ptRouterPlanMock.mockReturnValueOnce([itinerary]);
    const bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00]);

    const router = await buildPtRouter(bytes);
    const result = await planWithWasm(router, QUERY, "20260523");

    expect(FakeWorker.instances).toHaveLength(1);
    expect(latestWorker().url).toMatch(/ptRouter\.worker\.ts/);
    expect(result).toEqual([itinerary]);
    expect(ptRouterCtorMock.mock.calls[0]![0]).toEqual(bytes);
    expect((ptRouterPlanMock.mock.calls[0]![0] as { date: string }).date).toBe("20260523");
    expect(router.isAlive()).toBe(true);
  });

  it("the default build starts one router worker and gives the handle no arrive-by channel", async () => {
    const before = FakeWorker.instances.length;
    const router = await buildPtRouter(new Uint8Array([1]), "vilnius");
    expect(FakeWorker.instances.length - before).toBe(1);
    expect(latestWorker().received[0]).toMatchObject({ op: "init" });
    expect(Object.hasOwn(latestWorker().received[0]!, "city")).toBe(false);
    expect(router.arriveBy).toBeUndefined();
  });

  it("leaves the caller's bytes usable: the worker gets a copy", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const transfers = new Uint8Array([5, 6, 7]);
    const router = await buildPtRouter(bytes);
    await router.setTransfers(transfers);

    expect(bytes.byteLength).toBe(4);
    expect(transfers.byteLength).toBe(3);
    expect(ptRouterSetTransfersMock.mock.calls[0]![0]).toEqual(transfers);
  });

  it("writes the cold-start marks to the page timeline", async () => {
    await buildPtRouter(new Uint8Array([1]));
    for (const step of ["import", "instantiate", "ptnew"]) {
      expect(performance.getEntriesByName(`ptn:wasm:${step}:start`, "mark")).toHaveLength(1);
      expect(performance.getEntriesByName(`ptn:wasm:${step}:end`, "mark")).toHaveLength(1);
    }
    const at = (name: string): number => performance.getEntriesByName(name, "mark")[0]!.startTime;
    expect(at("ptn:wasm:import:end")).toBeGreaterThanOrEqual(at("ptn:wasm:import:start"));
    expect(at("ptn:wasm:ptnew:end")).toBeGreaterThanOrEqual(at("ptn:wasm:instantiate:start"));
  });

  it("maps init failures to the in-process error types and terminates the worker", async () => {
    FakeWorker.loadWasm = () => Promise.reject(new TypeError("network 404"));
    await expect(buildPtRouter(new Uint8Array([1]))).rejects.toBeInstanceOf(PtWasmImportError);
    expect(latestWorker().terminated).toBe(true);

    FakeWorker.loadWasm = () => import("@pt/wasm") as Promise<PtWasmModule>;
    wasmInitMock.mockRejectedValueOnce(new Error("expected magic word"));
    await expect(buildPtRouter(new Uint8Array([1]))).rejects.toBeInstanceOf(PtWasmInitError);
    expect(latestWorker().terminated).toBe(true);

    ptRouterCtorMock.mockImplementationOnce(() => { throw new Error("ptb: bad magic"); });
    await expect(buildPtRouter(new Uint8Array([1]))).rejects.toThrow(
      expect.objectContaining({ name: "PtWasmInitError", message: expect.stringMatching(/ptb: bad magic/) }),
    );
  });

  it("keeps the per-call error types", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));

    ptRouterPlanMock.mockImplementationOnce(() => { throw new Error("unknown stopId"); });
    await expect(planWithWasm(router, QUERY, "20260523")).rejects.toThrow(
      expect.objectContaining({ name: "PtWasmQueryError", message: expect.stringMatching(/unknown stopId/) }),
    );

    ptRouterResolveTimeMock.mockImplementationOnce(() => { throw new Error("UnsupportedVersion"); });
    await expect(router.resolveTime(1)).rejects.toBeInstanceOf(PtWasmTimeError);

    ptRouterSetTransfersMock.mockImplementationOnce(() => { throw new Error("transfers decode: BadMagic"); });
    await expect(router.setTransfers(new Uint8Array([1]))).rejects.toThrow(/transfers decode: BadMagic/);

    // The router still answers after each failure.
    ptRouterResolveTimeMock.mockReturnValueOnce({ serviceDate: "20260523", timeOriginUnix: 0, departureSecs: 0 });
    await expect(router.resolveTime(1)).resolves.toEqual({ serviceDate: "20260523", timeOriginUnix: 0, departureSecs: 0 });
  });

  it("free() lets an in-flight plan finish, then terminates the worker", async () => {
    ptRouterPlanMock.mockReturnValue([]);
    const router = await buildPtRouter(new Uint8Array([1]));
    const inFlight = router.plan({ entryStops: [], exitStops: [], date: "20260523", departureSecs: 0 });

    router.free();
    router.free();
    expect(router.isAlive()).toBe(false);
    expect(latestWorker().terminated).toBe(false);

    await expect(inFlight).resolves.toEqual([]);
    expect(latestWorker().terminated).toBe(true);
    await expect(planWithWasm(router, QUERY, "20260523")).rejects.toBeInstanceOf(PtWasmQueryError);
    await expect(router.resolveTime(1)).rejects.toBeInstanceOf(PtWasmTimeError);
    await expect(router.setTransfers(new Uint8Array([1]))).rejects.toBeInstanceOf(PtWasmTransfersError);
  });

  it("free() with nothing in flight terminates the worker at once", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));
    router.free();
    expect(latestWorker().terminated).toBe(true);
  });

  it("a request that cannot be posted rejects without blocking free()", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));
    const query = { entryStops: [], exitStops: [], date: "20260523", departureSecs: 0, bad: () => {} };

    await expect(router.plan(query)).rejects.toThrow();
    router.free();
    expect(latestWorker().terminated).toBe(true);
  });

  it("a crashed worker rejects what is pending and reports not alive", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));
    const worker = latestWorker();
    // Hold the reply so the crash lands while the request is pending.
    worker.postMessage = () => {};
    const pending = router.plan({ entryStops: [], exitStops: [], date: "20260523", departureSecs: 0 });

    worker.crash("out of memory");

    await expect(pending).rejects.toThrow(/out of memory/);
    expect(router.isAlive()).toBe(false);
    expect(worker.terminated).toBe(true);
    await expect(router.resolveTime(1)).rejects.toBeInstanceOf(PtWasmTimeError);
  });

  it("a worker that dies before answering init is an import failure", async () => {
    const build = buildPtRouter(new Uint8Array([1]));
    latestWorker().crash("worker script 404");
    await expect(build).rejects.toBeInstanceOf(PtWasmImportError);
  });
});

describe("createPtRouterHost", () => {
  const load = (): Promise<PtWasmModule> => import("@pt/wasm") as Promise<PtWasmModule>;

  it("runs requests in arrival order, so a call sent during init waits for it", async () => {
    let releaseInit!: () => void;
    wasmInitMock.mockReturnValueOnce(new Promise<void>((resolve) => { releaseInit = resolve; }));
    ptRouterPlanMock.mockReturnValueOnce(["planned"]);
    const handle = createPtRouterHost(load);

    const init = handle({ id: 0, op: "init", bytes: new Uint8Array([1]).buffer, mode: "off" });
    const plan = handle({ id: 1, op: "plan", query: {} });
    releaseInit();

    await expect(init).resolves.toMatchObject({ id: 0, ok: true });
    await expect(plan).resolves.toEqual({ id: 1, ok: true, value: ["planned"] });
  });

  it("refuses calls before init and a second init", async () => {
    const handle = createPtRouterHost(load);
    await expect(handle({ id: 0, op: "plan", query: {} })).resolves.toMatchObject({ ok: false, stage: "call" });
    await expect(handle({ id: 1, op: "init", bytes: new ArrayBuffer(1), mode: "off" })).resolves.toMatchObject({ ok: true });
    await expect(handle({ id: 2, op: "init", bytes: new ArrayBuffer(1), mode: "off" })).resolves.toMatchObject({ ok: false });
    expect(ptRouterCtorMock).toHaveBeenCalledTimes(1);
  });
});
