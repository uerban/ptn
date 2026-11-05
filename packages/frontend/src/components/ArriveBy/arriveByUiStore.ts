/**
 * Session state of the opt-in Arrive-by UI: the chosen mode, the deadline the
 * toolbar shows (the draft), and the deadline the results use (applied).
 * In memory only, so returning to Search restores it and a reload does not.
 */
import { create } from "zustand";

export type ArriveByMode = "leave-now" | "arrive-by";

interface ArriveByUiState {
  readonly cityId: string | null;
  readonly mode: ArriveByMode;
  /** Deadline in the toolbar, epoch ms; null while the inputs are incomplete. */
  readonly draftMs: number | null;
  /** True once the rider changed the deadline; a mode switch then keeps it. */
  readonly edited: boolean;
  /** Bumped when the draft is set for the rider, so the inputs re-read it. */
  readonly draftVersion: number;
  /** The applied deadline; null shows the normal results. */
  readonly appliedMs: number | null;
  /** Default deadline per endpoint pair, from its initial Recommended page. */
  readonly defaults: Readonly<Record<string, number>>;
  chooseArriveBy(defaultMs: number): void;
  chooseLeaveNow(): void;
  editDraft(ms: number | null): void;
  apply(): void;
  rememberDefault(pairKey: string, ms: number): void;
  syncCity(cityId: string): void;
}

const initial = {
  mode: "leave-now" as ArriveByMode, draftMs: null, edited: false, appliedMs: null, defaults: {},
};

export const useArriveByUi = create<ArriveByUiState>()((set, get) => ({
  cityId: null,
  draftVersion: 0,
  ...initial,
  chooseArriveBy(defaultMs) {
    const s = get();
    if (s.mode === "arrive-by") return;
    if (s.edited && s.draftMs !== null) set({ mode: "arrive-by" });
    else set({ mode: "arrive-by", draftMs: defaultMs, edited: false, draftVersion: s.draftVersion + 1 });
  },
  chooseLeaveNow() {
    set({ mode: "leave-now", appliedMs: null });
  },
  editDraft(ms) {
    set({ draftMs: ms, edited: true });
  },
  apply() {
    const { mode, draftMs } = get();
    if (mode === "arrive-by" && draftMs !== null) set({ appliedMs: draftMs });
  },
  rememberDefault(pairKey, ms) {
    const { defaults } = get();
    if (pairKey in defaults) return;
    set({ defaults: { ...defaults, [pairKey]: ms } });
  },
  syncCity(cityId) {
    const s = get();
    if (s.cityId === cityId) return;
    // Changing city resets to Leave now (spec); the first sync only records it.
    set(s.cityId === null ? { cityId } : { cityId, ...initial, draftVersion: s.draftVersion + 1 });
  },
}));

/** Identity of an endpoint pair for the cached default deadline. */
export function endpointPairKey(origin: unknown, destination: unknown): string {
  return JSON.stringify([origin, destination]);
}
