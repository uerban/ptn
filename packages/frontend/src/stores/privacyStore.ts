import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  AXIS_STRICTNESS_ORDER,
  effectivePolicy,
  PRIVACY_LEVELS,
  type PrivacyLevel,
  type PrivacyPolicy,
} from "@pt/shared/privacy";

export interface SetLevelOptions {
  /**
   * Confirm prompt fired only on a downgrade. Returning `false` cancels the
   * change. The UI passes `window.confirm` (or a custom dialog); tests pass
   * a stub. When omitted, downgrades proceed silently — kept as a default
   * so non-UI callers (tests, programmatic resets) don't have to mock.
   */
  confirm?: (message: string) => boolean;
  /** Message handed to `confirm`. Defaults to `DEFAULT_DOWNGRADE_MESSAGE`. */
  downgradeMessage?: string;
}

export type LevelChangeListener = (
  prev: PrivacyLevel,
  next: PrivacyLevel,
) => Promise<void> | void;

const levelChangeListeners = new Set<LevelChangeListener>();

/**
 * Register a listener invoked after a successful level change. Used by
 * `recents.ts` to re-encrypt / move records when the storage tier shifts.
 * Returns an unsubscriber.
 */
export function registerLevelChangeListener(
  fn: LevelChangeListener,
): () => void {
  levelChangeListeners.add(fn);
  return () => {
    levelChangeListeners.delete(fn);
  };
}

/** Test-only: drops every registered listener. */
export function __clearLevelChangeListenersForTests(): void {
  levelChangeListeners.clear();
}

export const DEFAULT_DOWNGRADE_MESSAGE =
  "Lowering your privacy level can re-expose previously protected data on this device. Continue?";

function isDowngrade(prev: PrivacyLevel, next: PrivacyLevel): boolean {
  return PRIVACY_LEVELS.indexOf(next) < PRIVACY_LEVELS.indexOf(prev);
}

interface PrivacyState {
  level: PrivacyLevel;
  overrides: Partial<PrivacyPolicy>;
  /**
   * Map of cityId → epoch ms of when the M11 tile prefetch completed for
   * that city. Ephemeral (not persisted): cleared on reload so the next
   * session re-prefetches. Used by the tile-defense dispatcher to decide
   * whether a city-switch load should fan out over the full tile grid.
   */
  prefetchedCities: Readonly<Record<string, number>>;
  /**
   * Sets the privacy level. Resolves to `true` if the level was actually
   * changed, or `false` if (a) the user cancelled the downgrade confirm or
   * (b) the requested level matches the current one. After updating state,
   * registered level-change listeners run sequentially so callers may
   * `await` to ensure side-effects (e.g. recents re-encryption) have
   * completed.
   *
   * State is updated synchronously before the first `await`, so existing
   * non-awaited callers still observe the new level immediately.
   */
  setLevel: (level: PrivacyLevel, opts?: SetLevelOptions) => Promise<boolean>;
  setOverride: <K extends keyof PrivacyPolicy>(
    axis: K,
    value: PrivacyPolicy[K],
  ) => void;
  clearOverride: <K extends keyof PrivacyPolicy>(axis: K) => void;
  markCityPrefetched: (cityId: string, at?: number) => void;
  clearPrefetchedCities: () => void;
  reset: () => void;
}

const DEFAULT_LEVEL: PrivacyLevel = "standard";

function isPrivacyLevel(value: unknown): value is PrivacyLevel {
  return typeof value === "string" && (PRIVACY_LEVELS as readonly string[]).includes(value);
}

function isValidAxisValue<K extends keyof PrivacyPolicy>(
  axis: K,
  value: unknown,
): value is PrivacyPolicy[K] {
  const order = AXIS_STRICTNESS_ORDER[axis];
  if (order.kind === "numeric") {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }
  return (order.values as readonly unknown[]).includes(value);
}

function sanitizeOverrides(raw: unknown): Partial<PrivacyPolicy> {
  if (!raw || typeof raw !== "object") return {};
  const result: Partial<PrivacyPolicy> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in AXIS_STRICTNESS_ORDER)) continue;
    const axis = k as keyof PrivacyPolicy;
    if (isValidAxisValue(axis, v)) {
      (result as Record<string, unknown>)[axis] = v;
    }
  }
  return result;
}

export const usePrivacyStore = create<PrivacyState>()(
  persist(
    (set, get) => ({
      level: DEFAULT_LEVEL,
      overrides: {},
      prefetchedCities: {},
      setLevel: async (level, opts) => {
        const prev = get().level;
        if (prev === level) return false;
        if (isDowngrade(prev, level) && opts?.confirm) {
          const message = opts.downgradeMessage ?? DEFAULT_DOWNGRADE_MESSAGE;
          if (!opts.confirm(message)) return false;
        }
        set({ level });
        for (const fn of levelChangeListeners) {
          try {
            await fn(prev, level);
          } catch {
            // Listener failures must not strand the user mid-change.
          }
        }
        return true;
      },
      setOverride: (axis, value) =>
        set((state) => ({
          overrides: { ...state.overrides, [axis]: value },
        })),
      clearOverride: (axis) =>
        set((state) => {
          if (!(axis in state.overrides)) return {};
          const next = { ...state.overrides };
          delete next[axis];
          return { overrides: next };
        }),
      markCityPrefetched: (cityId, at) =>
        set((state) => ({
          prefetchedCities: {
            ...state.prefetchedCities,
            [cityId]: at ?? Date.now(),
          },
        })),
      clearPrefetchedCities: () => set({ prefetchedCities: {} }),
      reset: () =>
        set({ level: DEFAULT_LEVEL, overrides: {}, prefetchedCities: {} }),
    }),
    {
      name: "ptn-privacy",
      // Only `level` and `overrides` persist. `prefetchedCities` stays
      // in-memory per spec ("ephemeral") so every reload re-runs the tile
      // prefetch defense.
      partialize: (state) => ({
        level: state.level,
        overrides: state.overrides,
      }),
      merge: (persisted, current) => {
        const stored = persisted as Partial<PrivacyState> | undefined;
        return {
          ...current,
          level: isPrivacyLevel(stored?.level) ? stored.level : current.level,
          overrides: sanitizeOverrides(stored?.overrides),
        };
      },
    },
  ),
);

export function usePolicy(): PrivacyPolicy {
  const level = usePrivacyStore((s) => s.level);
  const overrides = usePrivacyStore((s) => s.overrides);
  return effectivePolicy(level, overrides);
}

export function getPolicy(): PrivacyPolicy {
  const { level, overrides } = usePrivacyStore.getState();
  return effectivePolicy(level, overrides);
}

// Raw current level — only for consumers that legitimately need to branch on
// the preset itself (e.g. the errorReporter's console-payload redaction tier,
// which spec'd in the privacy audit m7a notes —
// required axis behavior at each level"). All policy decisions still go
// through getPolicy() / usePolicy(); never compare `getCurrentLevel()` to
// gate an axis.
export function getCurrentLevel(): PrivacyLevel {
  return usePrivacyStore.getState().level;
}

export function hasCityBeenPrefetched(cityId: string): boolean {
  return cityId in usePrivacyStore.getState().prefetchedCities;
}

export function markCityPrefetched(cityId: string, at?: number): void {
  usePrivacyStore.getState().markCityPrefetched(cityId, at);
}
