/**
 * Cross-tab coordination for privacy state.
 *
 * - Change propagation: another tab's localStorage write fires a `storage`
 *   event here; subscribers re-read (rehydrate) the affected store so a
 *   revocation takes effect in every open tab.
 * - Migration locking: one tab at a time runs a migration. Web Locks
 *   (`navigator.locks`) when available, otherwise a localStorage lease with
 *   an expiry so a crashed tab cannot hold it forever.
 */

import { safeLocalStorage } from "./tolerantLocalStorage.ts";

type StorageEventTarget = Pick<Window, "addEventListener" | "removeEventListener">;

function defaultTarget(): StorageEventTarget | undefined {
  return typeof window === "undefined" ? undefined : window;
}

/**
 * Call `onChange` whenever another tab changes (or clears) `key`. The event
 * only fires for writes made by other documents, so a tab never reacts to
 * its own writes. Returns an unsubscriber.
 */
export function onStorageKeyChange(
  key: string,
  onChange: () => void,
  target: StorageEventTarget | undefined = defaultTarget(),
): () => void {
  if (!target) return () => {};
  const listener = (event: Event) => {
    const storageEvent = event as StorageEvent;
    // `key === null` means another tab called localStorage.clear().
    if (storageEvent.key !== null && storageEvent.key !== key) return;
    try {
      onChange();
    } catch {
      // A failed refresh must not break other listeners; the next change or
      // reload re-reads the store anyway.
    }
  };
  target.addEventListener("storage", listener);
  return () => target.removeEventListener("storage", listener);
}

// --- Migration lock ---------------------------------------------------------

interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface MigrationLockOptions {
  /** Lease lifetime for the localStorage fallback. */
  leaseMs?: number;
  /** Poll interval while another tab holds the lease. */
  retryMs?: number;
  locks?: LockManagerLike | null;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const LEASE_PREFIX = "ptn-lock:";
const DEFAULT_LEASE_MS = 10_000;
const DEFAULT_RETRY_MS = 50;

function defaultLocks(): LockManagerLike | null {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const locks = (nav as { locks?: LockManagerLike } | undefined)?.locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

function defaultLeaseStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  return safeLocalStorage() ?? null;
}

function randomOwner(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

interface Lease {
  owner: string;
  expires: number;
}

function readLease(
  storage: Pick<Storage, "getItem">,
  key: string,
): Lease | null {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Lease).owner === "string" &&
      typeof (parsed as Lease).expires === "number"
    ) {
      return parsed as Lease;
    }
  } catch {
    // A malformed lease is treated as absent.
  }
  return null;
}

/**
 * Run `fn` while holding the named migration lock. Migrations guarded this
 * way must still be idempotent: the lease fallback is best effort (two tabs
 * can race between write and read-back), and an expired lease is taken over.
 */
export async function withMigrationLock<T>(
  name: string,
  fn: () => Promise<T> | T,
  options: MigrationLockOptions = {},
): Promise<T> {
  const locks = options.locks === undefined ? defaultLocks() : options.locks;
  if (locks) {
    return locks.request(`ptn-${name}`, { mode: "exclusive" }, async () => fn());
  }

  const storage =
    options.storage === undefined ? defaultLeaseStorage() : options.storage;
  if (!storage) return fn();

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const key = `${LEASE_PREFIX}${name}`;
  const owner = randomOwner();

  for (;;) {
    const current = readLease(storage, key);
    if (!current || current.expires <= now()) {
      try {
        storage.setItem(key, JSON.stringify({ owner, expires: now() + leaseMs }));
      } catch {
        // Storage refused the lease: nothing to coordinate through.
        return fn();
      }
      if (readLease(storage, key)?.owner === owner) break;
    }
    await sleep(retryMs);
  }

  try {
    return await fn();
  } finally {
    try {
      if (readLease(storage, key)?.owner === owner) storage.removeItem(key);
    } catch {
      // The lease expires on its own.
    }
  }
}
