import type { PrivacyPolicy } from "@pt/shared";

export interface TileLoadPlan {
  tileKeys: string[];
  decoyKeys: string[];
  markPrefetched: boolean;
  decoyTimerActive: boolean;
}

export interface DispatchContext {
  cityTileKeys?: readonly string[];
  cachedKeys?: ReadonlySet<string>;
  prefetched?: boolean;
  rng?: () => number;
}

const PADDING_DECOY_COUNT = 2;
const SESSION_NONCE_KEY = "ptn_tile_defense_nonce";

// Mulberry32 — a tiny 32-bit PRNG that produces a reproducible [0, 1) stream
// from a seed. Chosen over Math.random so the padding strategy is
// session-stable (decoys for identical inputs in one session match on replay)
// but unpredictable across sessions (fresh nonce each reload).
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashToSeed(input: string): number {
  // FNV-1a 32-bit — deterministic, no crypto requirement (seeds don't need
  // collision resistance, just a uniform spread over 32 bits).
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

let sessionNonce: string | null = null;

function readStoredNonce(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(SESSION_NONCE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStoredNonce(nonce: string): void {
  try {
    globalThis.sessionStorage?.setItem(SESSION_NONCE_KEY, nonce);
  } catch {
    // sessionStorage unavailable (SSR, private mode) — nonce stays in-memory
  }
}

function getSessionNonce(): string {
  if (sessionNonce) return sessionNonce;
  const stored = readStoredNonce();
  if (stored) {
    sessionNonce = stored;
    return sessionNonce;
  }
  sessionNonce =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  writeStoredNonce(sessionNonce);
  return sessionNonce;
}

/** Test-only: drop the cached nonce so the next call regenerates it. */
export function _resetSessionNonceForTests(): void {
  sessionNonce = null;
  try {
    globalThis.sessionStorage?.removeItem(SESSION_NONCE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Test-only: pin the session nonce to a fixed value so the default decoy RNG
 * is reproducible run-to-run. Without this, tests that exercise the default
 * RNG inherit a fresh random nonce per run (crypto.randomUUID / Math.random),
 * making any assertion over a *particular* decoy outcome probabilistically
 * flaky. Still exercises the real `defaultRng` seeding path — only the nonce
 * source is fixed.
 */
export function _setSessionNonceForTests(nonce: string): void {
  sessionNonce = nonce;
  writeStoredNonce(nonce);
}

/**
 * Build the default decoy RNG. Seed combines the per-session nonce with
 * the call's real-tile fingerprint, so:
 *   - identical inputs in one session → identical decoys (testable, audit-friendly)
 *   - different sessions → different decoys (no cross-session fingerprint)
 *   - different real-tile sets in one session → different decoys (padding varies)
 */
function defaultRng(realKeys: readonly string[]): () => number {
  const seed = hashToSeed(`${getSessionNonce()}::${realKeys.join(",")}`);
  return mulberry32(seed);
}

function pickDecoys(
  candidates: readonly string[],
  count: number,
  rng: () => number,
): string[] {
  if (count <= 0 || candidates.length === 0) return [];
  const pool = candidates.slice();
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, take);
}

export function dispatchTileLoad(
  realTileKeys: readonly string[],
  policy: Pick<PrivacyPolicy, "m11TileDefense">,
  ctx: DispatchContext = {},
): TileLoadPlan {
  const strategy = policy.m11TileDefense;
  const realSet = new Set(realTileKeys);

  if (strategy === "none") {
    return {
      tileKeys: realTileKeys.slice(),
      decoyKeys: [],
      markPrefetched: false,
      decoyTimerActive: false,
    };
  }

  const wantsPrefetch =
    strategy === "prefetch" ||
    strategy === "prefetch-padding" ||
    strategy === "prefetch-padding-decoy";
  const wantsPadding =
    strategy === "prefetch-padding" ||
    strategy === "prefetch-padding-decoy";
  const decoyTimerActive = strategy === "prefetch-padding-decoy";

  const shouldPrefetchNow =
    wantsPrefetch &&
    ctx.prefetched !== true &&
    !!ctx.cityTileKeys &&
    ctx.cityTileKeys.length > 0;

  const cached = ctx.cachedKeys;
  const filterCached = (keys: readonly string[]): string[] =>
    cached ? keys.filter((k) => !cached.has(k)) : keys.slice();

  const base = shouldPrefetchNow
    ? Array.from(
        new Set(filterCached([...(ctx.cityTileKeys ?? []), ...realTileKeys])),
      )
    : filterCached(realTileKeys);

  let decoys: string[] = [];
  if (wantsPadding && ctx.cityTileKeys) {
    const baseSet = new Set(base);
    const candidates = ctx.cityTileKeys.filter(
      (k) =>
        !realSet.has(k) &&
        !baseSet.has(k) &&
        !(cached?.has(k) ?? false),
    );
    decoys = pickDecoys(
      candidates,
      PADDING_DECOY_COUNT,
      ctx.rng ?? defaultRng(realTileKeys),
    );
  }

  return {
    tileKeys: [...base, ...decoys],
    decoyKeys: decoys,
    markPrefetched: shouldPrefetchNow,
    decoyTimerActive,
  };
}

// --- Decoy-on-timer runtime (Paranoid / "prefetch-padding-decoy") ---

const DEFAULT_DECOY_MIN_MS = 2 * 60 * 1000;
const DEFAULT_DECOY_MAX_MS = 5 * 60 * 1000;

export interface VisibilityTarget {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface DecoyTimerOptions {
  cityTileKeys: readonly string[];
  onFire: (tileKey: string) => void | Promise<void>;
  intervalMinMs?: number;
  intervalMaxMs?: number;
  rng?: () => number;
  visibilityTarget?: VisibilityTarget;
}

export interface DecoyTimerController {
  stop(): void;
}

function resolveVisibilityTarget(
  provided?: VisibilityTarget,
): VisibilityTarget | undefined {
  if (provided) return provided;
  if (typeof document !== "undefined") {
    return document as unknown as VisibilityTarget;
  }
  return undefined;
}

export function startDecoyTimer(opts: DecoyTimerOptions): DecoyTimerController {
  const minMs = opts.intervalMinMs ?? DEFAULT_DECOY_MIN_MS;
  const maxMs = opts.intervalMaxMs ?? DEFAULT_DECOY_MAX_MS;
  const rng = opts.rng ?? Math.random;
  const target = resolveVisibilityTarget(opts.visibilityTarget);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const isHidden = (): boolean => target?.visibilityState === "hidden";
  const span = Math.max(0, maxMs - minMs);
  const nextDelay = (): number => minMs + Math.floor(rng() * (span + 1));

  const clearPending = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const fire = (): void => {
    timer = null;
    if (stopped) return;
    const pool = opts.cityTileKeys;
    if (pool.length > 0) {
      const decoy = pool[Math.floor(rng() * pool.length)];
      try {
        const ret = opts.onFire(decoy);
        // Guard Promise rejections too — void on a rejected Promise would
        // surface as unhandledRejection otherwise.
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          (ret as Promise<unknown>).then(undefined, () => {});
        }
      } catch {
        // A throwing onFire must not kill the loop — swallow and reschedule.
      }
    }
    schedule();
  };

  const schedule = (): void => {
    if (stopped || timer !== null) return;
    if (opts.cityTileKeys.length === 0) return;
    if (isHidden()) return;
    timer = setTimeout(fire, nextDelay());
  };

  const onVisibilityChange = (): void => {
    if (stopped) return;
    if (isHidden()) {
      clearPending();
    } else {
      schedule();
    }
  };

  target?.addEventListener("visibilitychange", onVisibilityChange);
  schedule();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearPending();
      target?.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
