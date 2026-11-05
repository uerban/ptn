/**
 * Page side of the opt-in arrive-by owner worker (H74): starts the worker,
 * hands it a copy of the bundle, and gives the router handle an arrive-by
 * channel over it. Only an opt-in build bundles this module
 * (`ptRouterWorkerEntry.arriveBy.ts`).
 *
 * The owner worker is separate from the router worker, so a normal `plan` or
 * `resolveTime` never waits for an arrive-by request. Transfers keep the
 * order the shared worker gave them: the owner drops its transfers before the
 * router's update and gets the new ones only after that update succeeded.
 */
import type { ArriveByOwnerWorkerReply, ArriveByOwnerWorkerRequest } from "./ptArriveByOwnerHost.ts";
import { createArriveByChannel, type ArriveByChannel } from "./temporalArriveByClient.ts";

export interface ArriveByOwnerBundle {
  /** The caller keeps these bytes; the worker gets its own copy. */
  readonly bytes: Uint8Array;
  readonly mode: string;
  readonly city: string;
}

export interface ArriveByLink {
  readonly channel: ArriveByChannel;
  /** Before the normal router's transfer update. */
  invalidateTransfers(): void;
  /** After the normal router accepted `bytes`. Never rejects: a failure
   * leaves arrive-by unavailable, not the router. */
  replaceTransfers(bytes: Uint8Array): Promise<void>;
  /** Stops new calls; terminates the worker once the calls in flight answer. */
  free(): void;
}

export type ArriveByLinkFactory = (bundle: ArriveByOwnerBundle) => ArriveByLink;

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

function message(err: unknown): string { return err instanceof Error ? err.message : String(err); }

export function createArriveByLink(createWorker: () => Worker, bundle: ArriveByOwnerBundle): ArriveByLink {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  let nextId = 0;
  let freed = false;
  let crashed: Error | null = null;
  let worker: Worker | null = null;
  let invalidateChannel = (): void => {};

  const crash = (text: string): void => {
    if (crashed) return;
    crashed = new Error(text);
    invalidateChannel();
    worker?.terminate();
    for (const entry of pending.values()) entry.reject(crashed);
    pending.clear();
  };
  const terminateIfDrained = (): void => {
    if (freed && pending.size === 0) worker?.terminate();
  };

  try {
    worker = createWorker();
  } catch (err) {
    crashed = new Error(`arrive-by worker failed to start: ${message(err)}`);
  }
  if (worker) {
    worker.onmessage = (event: MessageEvent<ArriveByOwnerWorkerReply>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data.value);
      else entry.reject(new Error(event.data.error));
      terminateIfDrained();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      crash(event.message || "arrive-by owner worker failed");
    };
    worker.onmessageerror = () => crash("arrive-by owner worker sent an unreadable reply");
  }

  const send = (req: WithoutId<ArriveByOwnerWorkerRequest>, transfer: Transferable[] = []): Promise<unknown> => {
    if (crashed) return Promise.reject(crashed);
    if (freed) return Promise.reject(new Error("arrive-by owner has been freed"));
    const target = worker as Worker;
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        target.postMessage({ ...req, id }, transfer);
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  // Queued first, so every later request reaches an attached owner. A failed
  // attach answers each later request with its error.
  const initBytes = bundle.bytes.slice().buffer;
  void send({ op: "init", bytes: initBytes, mode: bundle.mode, city: bundle.city }, [initBytes]).catch(() => {});

  const channel = createArriveByChannel((req) => send(req));
  invalidateChannel = () => channel.invalidateInputs();

  return {
    channel,
    invalidateTransfers(): void {
      channel.invalidateInputs();
      void send({ op: "invalidateTransfers" }).then((value) => channel.observeTransfers(value), () => {});
    },
    async replaceTransfers(bytes: Uint8Array): Promise<void> {
      const buffer = bytes.slice().buffer;
      try { channel.observeTransfers(await send({ op: "replaceTransfers", bytes: buffer }, [buffer])); }
      catch { /* The owner stays without transfers; its requests fail typed. */ }
    },
    free(): void {
      if (freed) return;
      freed = true;
      channel.invalidateInputs();
      terminateIfDrained();
    },
  };
}
