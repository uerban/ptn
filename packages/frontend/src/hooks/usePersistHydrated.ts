import { useEffect, useState } from "react";

/** The `persist` API of a zustand store whose storage is asynchronous. */
export interface PersistHydrationApi {
  hasHydrated(): boolean;
  onFinishHydration(fn: () => void): () => void;
}

/**
 * True once a persisted store (or a store without persistence, as in some
 * tests) has loaded its stored state. Stores sealed with
 * the install key hydrate asynchronously; until then their state is a default
 * that must not be shown or edited as if it were the rider's data.
 */
export function usePersistHydrated(api: PersistHydrationApi | undefined): boolean {
  const [hydrated, setHydrated] = useState(() => !api || api.hasHydrated());
  useEffect(() => {
    if (!api || api.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return api.onFinishHydration(() => setHydrated(true));
  }, [api]);
  return hydrated;
}

/** Runs `fn` once the store has hydrated (immediately if it already has). */
export function afterPersistHydration(
  api: PersistHydrationApi | undefined,
  fn: () => void,
): () => void {
  if (!api || api.hasHydrated()) {
    fn();
    return () => {};
  }
  return api.onFinishHydration(fn);
}
