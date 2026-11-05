import { create } from "zustand";
import type { ColorConfig } from "@pt/shared";
import { api, HttpError, BackendStartingError } from "../services/api.ts";

const MAX_RETRIES = 3;            // bounded retries for a genuine (non-startup) error
const BASE_DELAY_MS = 2000;
const STARTUP_RETRY_CAP_MS = 30_000; // cap for the indefinite startup-class backoff

/**
 * Startup-class = the backend is (re)starting/unavailable, worth retrying
 * indefinitely (capped) because it WILL recover: an HttpError 502/503/504, a
 * fetch-level network error (TypeError), or a 200-with-non-JSON body
 * (BackendStartingError). A plain Error or a 4xx/5xx-with-body (HttpError with
 * another status) is a genuine failure → bounded retries then give up.
 */
function isStartupClass(e: unknown): boolean {
  if (e instanceof HttpError) return e.status === 502 || e.status === 503 || e.status === 504;
  if (e instanceof BackendStartingError) return true;
  if (e instanceof TypeError) return true; // window.fetch network failure
  return false;
}

interface ColorConfigState {
  config: ColorConfig | null;
  cityId: string | null;
  loading: boolean;
  error: string | null;
  status: "idle" | "loading" | "backend-starting" | "ready" | "error";
  _requestId: number;
  fetchForCity: (cityId: string) => Promise<void>;
  reset: () => void;
}

export const useColorConfigStore = create<ColorConfigState>()((set, get) => ({
  config: null,
  cityId: null,
  loading: false,
  error: null,
  status: "idle",
  _requestId: 0,

  async fetchForCity(cityId: string) {
    if (get().cityId === cityId && (get().config || get().loading)) return;
    const isNewCity = get().cityId !== cityId;
    const requestId = get()._requestId + 1;
    set({ loading: true, error: null, status: "loading", cityId, _requestId: requestId, ...(isNewCity ? { config: null } : {}) });

    const isStale = () => get()._requestId !== requestId;

    // `total` drives backoff timing + the "have we attempted yet" gate.
    // `genuine` counts ONLY non-startup failures — startup-class retries are
    // indefinite, so they must NOT consume the bounded genuine-error budget
    // (otherwise a burst of 503s while starting would make a later real error
    // give up immediately).
    let total = 0;
    let genuine = 0;
    for (;;) {
      if (total > 0) {
        const startup = get().status === "backend-starting";
        // Bounded path's exponent uses `genuine` so startup retries can't inflate
        // (or skip) the 2s/4s/8s schedule the existing fake-timer tests assert.
        const exp = startup ? total : genuine;
        const raw = BASE_DELAY_MS * 2 ** (exp - 1);
        // Jitter ONLY on the startup-class path: keeps the bounded delays exact
        // (the existing tests advance by exactly 2_000ms) and spreads retries
        // when many clients hammer a starting backend.
        const delay = startup
          ? Math.min(STARTUP_RETRY_CAP_MS, raw) + Math.floor(Math.random() * 250)
          : raw;
        await new Promise((r) => setTimeout(r, delay));
        if (isStale()) return;
      }
      try {
        const config = await api.getColorConfig();
        if (isStale()) return;
        set({ config, loading: false, status: "ready", error: null });
        return;
      } catch (e) {
        if (isStale()) return;
        console.debug(`[color-config] fetch attempt ${total + 1} failed:`, e);
        total++;
        if (isStartupClass(e)) {
          // Indefinite capped retry — the backend is starting and will recover.
          set({ status: "backend-starting" });
          continue;
        }
        // Genuine error: bounded retries, then give up.
        genuine++;
        if (genuine > MAX_RETRIES) {
          console.warn("[color-config] all retries exhausted, giving up");
          set({ config: null, loading: false, status: "error", error: "Failed to load route colors" });
          return;
        }
      }
    }
  },

  reset() {
    set({ config: null, cityId: null, loading: false, error: null, status: "idle", _requestId: get()._requestId + 1 });
  },
}));
