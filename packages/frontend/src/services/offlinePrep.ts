/**
 * "Prepare for offline" — warm everything the app fetches lazily, on the
 * user's command, while they still have a connection.
 *
 * The app is offline-capable but not offline-*prepared*: schedule tiles are
 * fetched per stop on demand, the idle prewarm takes one tile at the map
 * centre, and the locale/privacy chunks are deliberately out of the precache
 * (see sw/precache.ts). Someone about to descend into a tunnel has a minute of
 * signal and no way to spend it.
 *
 * Policy, not bypass. Warming means network requests, and each schedule/POI
 * tile request reveals a coarse grid cell — the surface the tile-defense
 * strategy exists to blunt (see the `m11Tiles` disclosure). So this module
 * plans against the active privacy level and POI fetch mode rather than
 * reaching past them: it drops steps the level forbids, and reports what it
 * cannot do instead of quietly doing less.
 *
 * Map-decoupled by injection, like scheduleTilePrewarm — every dependency is
 * passed in, so the whole thing is unit-testable without WebGL or a network.
 */
import type { PrivacyLevel } from "@pt/shared/privacy";
import type { PoiFetchMode } from "@pt/shared";

export type OfflinePrepStepId = "i18n" | "manifest" | "scheduleTiles" | "poi";

/** Default ceiling for one run, mirroring the idle prewarm's session budget. */
export const DEFAULT_PREP_BYTE_BUDGET = 8_000_000;

export interface OfflinePrepPlan {
  steps: OfflinePrepStepId[];
  /**
   * True when the active preset deliberately avoids traffic like this, so the
   * user must opt in explicitly rather than have the preset imply consent.
   */
  requiresConfirmation: boolean;
  /** Things this run will NOT achieve, for the UI to state plainly. */
  restrictions: string[];
}

export function planOfflinePrep(input: {
  level: PrivacyLevel;
  poiMode: PoiFetchMode;
}): OfflinePrepPlan {
  const { level, poiMode } = input;
  const steps: OfflinePrepStepId[] = ["i18n", "manifest", "scheduleTiles"];
  const restrictions: string[] = [];

  if (poiMode === "server-side") {
    // Residency invariant: this client is not meant to hold a POI corpus.
    // Preparing for offline must not become a way around that.
    restrictions.push(
      "Place search stays on the server at this setting, so it will not work offline.",
    );
  } else {
    steps.push("poi");
  }

  // Real-time departures are ephemeral by construction — the rt-tile endpoint
  // is NetworkOnly and its payload is stale within minutes. Warming it would
  // be a promise the data cannot keep.
  restrictions.push(
    "Live departures need a connection; offline falls back to the timetable.",
  );
  if (level === "paranoid") {
    restrictions.push(
      "Real-time polling is off entirely at Paranoid, online or offline.",
    );
  }

  return {
    steps,
    // Baseline's whole promise is "load on demand, no extra traffic".
    requiresConfirmation: level === "baseline",
    restrictions,
  };
}

export interface OfflinePrepDeps {
  /** Warm the lazily-fetched locale + privacy chunks into the SW cache. */
  warmI18n: () => Promise<void>;
  warmManifest: () => Promise<void>;
  getManifest: () => { manifest: unknown; bundleHash: string } | null;
  /** Schedule-tile coords worth holding — typically the active city's grid. */
  tileCoordsToWarm: () => Promise<string[]>;
  /** Fetch + cache one schedule tile; returns bytes downloaded (0 if cached). */
  warmTile: (
    tileCoord: string,
    shared: { manifest: unknown; bundleHash: string },
  ) => Promise<number>;
  /** Warm the POI corpus through the existing, policy-gated sync path. */
  warmPoi?: () => Promise<void>;
  byteBudget?: number;
}

export interface OfflinePrepProgress {
  step: OfflinePrepStepId;
  done: number;
  total: number;
}

export interface OfflinePrepResult {
  ok: boolean;
  failed: OfflinePrepStepId[];
  tilesWarmed: number;
  bytesSpent: number;
  budgetExhausted: boolean;
  cancelled: boolean;
}

export async function runOfflinePrep(
  plan: OfflinePrepPlan,
  deps: OfflinePrepDeps,
  onProgress: (p: OfflinePrepProgress) => void,
  signal?: AbortSignal,
): Promise<OfflinePrepResult> {
  const budget = deps.byteBudget ?? DEFAULT_PREP_BYTE_BUDGET;
  const failed: OfflinePrepStepId[] = [];
  let tilesWarmed = 0;
  let bytesSpent = 0;
  let budgetExhausted = false;

  const cancelled = () => signal?.aborted === true;
  // One step failing must not strand the rest: a user on a flaky platform
  // still benefits from whatever else lands.
  const attempt = async (step: OfflinePrepStepId, fn: () => Promise<void>) => {
    if (cancelled()) return;
    try {
      await fn();
    } catch {
      failed.push(step);
    }
  };

  for (const step of plan.steps) {
    if (cancelled()) break;

    if (step === "i18n") {
      await attempt("i18n", async () => {
        await deps.warmI18n();
        onProgress({ step: "i18n", done: 1, total: 1 });
      });
      continue;
    }

    if (step === "manifest") {
      await attempt("manifest", async () => {
        await deps.warmManifest();
        onProgress({ step: "manifest", done: 1, total: 1 });
      });
      continue;
    }

    if (step === "scheduleTiles") {
      await attempt("scheduleTiles", async () => {
        const shared = deps.getManifest();
        if (!shared) {
          // Without a manifest there is no tile to address; fetching by bare
          // coordinate is exactly what the read path refuses to do.
          throw new Error("manifest unavailable");
        }
        const tileCoords = await deps.tileCoordsToWarm();
        for (const [i, tileCoord] of tileCoords.entries()) {
          if (cancelled()) return;
          // Predict with the last tile's size, as the idle prewarm does, so a
          // run stops before overshooting rather than after.
          const estimate = tilesWarmed > 0 ? bytesSpent / tilesWarmed : 0;
          if (bytesSpent + estimate > budget) {
            budgetExhausted = true;
            return;
          }
          bytesSpent += await deps.warmTile(tileCoord, shared);
          tilesWarmed += 1;
          onProgress({
            step: "scheduleTiles",
            done: i + 1,
            total: tileCoords.length,
          });
        }
      });
      continue;
    }

    if (step === "poi" && deps.warmPoi) {
      await attempt("poi", async () => {
        await deps.warmPoi?.();
        onProgress({ step: "poi", done: 1, total: 1 });
      });
    }
  }

  return {
    ok: failed.length === 0 && !cancelled(),
    failed,
    tilesWarmed,
    bytesSpent,
    budgetExhausted,
    cancelled: cancelled(),
  };
}
