import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db/index.ts";
import { subscribePersonalSession } from "../services/personalStorage.ts";
import {
  listSaves,
  resolveSavedRows,
  type ResolvedSave,
} from "../services/saves.ts";

/**
 * Every readable save (stored and session-only), newest first. Null while the
 * saves are being decrypted.
 */
export function useResolvedSaves(
  rowsOverride?: readonly unknown[] | null,
): ResolvedSave[] | null {
  // The live query only signals changes; rows are re-read and decrypted
  // through the saves service.
  const changed = useLiveQuery(() => db.savedLocations.toArray(), []);
  const [sessionTick, setSessionTick] = useState(0);
  const [resolved, setResolved] = useState<ResolvedSave[] | null>(null);

  useEffect(
    () => subscribePersonalSession(() => setSessionTick((n) => n + 1)),
    [],
  );

  useEffect(() => {
    if (!rowsOverride && !changed) return;
    let cancelled = false;
    const load = rowsOverride ? resolveSavedRows(rowsOverride) : listSaves();
    void load.then(
      (out) => {
        if (!cancelled) setResolved(out);
      },
      () => {
        if (!cancelled) setResolved([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rowsOverride, changed, sessionTick]);

  return resolved;
}
