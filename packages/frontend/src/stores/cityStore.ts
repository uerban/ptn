import { create } from "zustand";
import { persist } from "zustand/middleware";
import { CITIES, type CityConfig, getAvailableCities } from "../config/cities.ts";
import { evictPtbBytes } from "../services/gtfsBundleBytes.ts";
import { db } from "../db/index.ts";

// Re-export so existing import paths keep working.
export { getAvailableCities };

/**
 * Evict per-city Dexie rows belonging to any city OTHER than `activeId`
 * (F10). `setActiveCity` only evicts on a LIVE A→B transition; a cold start
 * that persist-rehydrates directly into city B never runs it, leaving city
 * A's ~5 MB `ptbBytes` row (and its `gtfsBundle` manifest) behind
 * indefinitely. Called from the persist `onRehydrateStorage` hook.
 * Fire-and-forget at the call site — same policy as the live-switch
 * eviction: a failed delete must not block startup.
 */
async function evictNonActiveCityBytes(activeId: string): Promise<void> {
  const [ptbKeys, bundleKeys] = await Promise.all([
    db.ptbBytes.toCollection().primaryKeys(),
    db.gtfsBundle.toCollection().primaryKeys(),
  ]);
  const deadPtb = ptbKeys.filter((k) => k !== activeId);
  const deadBundle = bundleKeys.filter((k) => k !== activeId);
  if (deadPtb.length > 0) await db.ptbBytes.bulkDelete(deadPtb);
  if (deadBundle.length > 0) await db.gtfsBundle.bulkDelete(deadBundle);
}

interface CityState {
  activeCity: CityConfig;
  setActiveCity: (city: CityConfig) => void;
  getApiUrl: () => string;
}

export const useCityStore = create<CityState>()(
  persist(
    (set, get) => ({
      activeCity: getAvailableCities()[0],
      // On city switch, evict the prior city's per-city Dexie state so
      // a stale row can't shadow the new city's data:
      //
      //   - `db.ptbBytes` — accumulates ~5 MB per city otherwise (panel DB F3).
      //   - `db.gtfsBundle` — carries `meta.transfersArtifact` (url + hash)
      //     that `wasmLifecycle.attachTransfersIfAvailable` reads. Without
      //     eviction, an A→B→A toggle reads city A's old manifest against
      //     city A's freshly downloaded PTB bytes; a hash-stable transfers
      //     rebuild over a changed stop-index space would silently attach
      //     a wrong-shape CSR.
      //
      // Eviction is fire-and-forget: a failure to delete must not block the
      // synchronous city-switch UI update (the new city's RAPTOR engine
      // bootstrap is the user-visible critical path). Errors are logged for
      // triage but swallowed.
      setActiveCity: (city) => {
        const prev = get().activeCity;
        set({ activeCity: city });
        if (prev && prev.id !== city.id) {
          evictPtbBytes(prev.id).catch((err) =>
            console.warn("[cityStore] failed to evict ptbBytes:", err),
          );
          db.gtfsBundle.delete(prev.id).catch((err) =>
            console.warn("[cityStore] failed to evict gtfsBundle:", err),
          );
        }
      },
      getApiUrl: () => `/api/${get().activeCity.id}`,
    }),
    {
      name: "ptn-city",
      // F10: a cold start rehydrating straight into city B bypasses
      // `setActiveCity`'s transition eviction — sweep other cities' cached
      // bytes here instead.
      onRehydrateStorage: () => (state) => {
        const activeId = state?.activeCity?.id;
        if (!activeId) return;
        // Defer until the boot path has opened the DB. Auto-opening from
        // here would race `ensureDbReady`'s migration/recovery pass (a
        // pre-migration connection can block its versionchange upgrade).
        const whenReady: Promise<unknown> = db.isOpen()
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              db.on("ready", () => resolve());
            });
        void whenReady
          .then(() => evictNonActiveCityBytes(activeId))
          .catch((err) => console.warn("[cityStore] rehydrate eviction failed:", err));
      },
      merge: (persisted, current) => {
        const stored = persisted as Partial<CityState> | undefined;
        const rawId = (stored?.activeCity as CityConfig | undefined)?.id;
        const storedId = rawId === "gdansk" ? "tricity" : rawId;
        const available = new Set(getAvailableCities().map((c) => c.id));
        const match = storedId ? CITIES.find((c) => c.id === storedId && available.has(c.id)) : undefined;
        return {
          ...current,
          activeCity: match ?? current.activeCity,
        };
      },
    }
  )
);
