import type { EngineMobilityProfile, MobilityProfile } from "../types/routing.js";
import {
  DEFAULT_MAX_WALK_SECS,
  DEFAULT_WALK_SPEED_MPS,
  MAX_RUN_SPEED_MPS,
  RAPTOR_MIN_TRANSFER_SECS,
  RUN_TO_CATCH_SPEED_FACTOR,
  VISION_IMPAIRED_WALK_SPEED_MPS,
  WHEELCHAIR_WALK_SPEED_MPS,
} from "../constants/defaults.js";

// Re-export so callers of this module can pull profile + walk-cap constants
// from a single import path (`@pt/shared` → routing/profile).
export type { EngineMobilityProfile, MobilityProfile };
export {
  DEFAULT_MAX_WALK_SECS,
  DEFAULT_WALK_SPEED_MPS,
  MAX_RUN_SPEED_MPS,
  VISION_IMPAIRED_WALK_SPEED_MPS,
  WHEELCHAIR_WALK_SPEED_MPS,
};

export interface WalkParamsInput {
  walkSpeedMps?: number;
  maxWalkSecs?: number;
}

export interface WalkParams {
  walkSpeedMps: number;
  maxWalkSecs: number;
}

/**
 * Single source of truth for translating settings + mobility profile into
 * walking parameters used by the routing engine. Called from settingsStore
 * (when the user flips the mobility toggle, or when the user adjusts walk
 * speed) and from any future orchestrator caller. Anywhere a third caller
 * appears, route through this function — do not inline the cap logic
 * again.
 *
 * The wheelchair cap rule: a wheelchair user may carry over a custom
 * walking speed BELOW the cap from a prior profile setting, but must not
 * exceed it. Hence `Math.min(requested, cap)` rather than a hard
 * overwrite.
 *
 * NaN / Infinity / non-positive inputs are coerced to defaults rather than
 * propagating. `Math.min(NaN, x)` returns `NaN`, which would then leak
 * into RAPTOR walk-time arithmetic and silently produce "no routes
 * found" with no diagnostic. Catching it here is the right seam — the
 * shared module is downstream of every caller's input validation.
 */
export function resolveWalkParams(
  profile: MobilityProfile,
  input: WalkParamsInput,
): WalkParams {
  const requestedSpeed = isPositiveFinite(input.walkSpeedMps)
    ? input.walkSpeedMps
    : DEFAULT_WALK_SPEED_MPS;
  const requestedMaxSecs = isPositiveFinite(input.maxWalkSecs)
    ? input.maxWalkSecs
    : DEFAULT_MAX_WALK_SECS;

  if (profile === "wheelchair") {
    return {
      walkSpeedMps: Math.min(requestedSpeed, WHEELCHAIR_WALK_SPEED_MPS),
      maxWalkSecs: requestedMaxSecs,
    };
  }
  return { walkSpeedMps: requestedSpeed, maxWalkSecs: requestedMaxSecs };
}

/**
 * Walking parameters when the rider switches to `profile`: the profile's
 * rules (`resolveWalkParams`) plus the speed a profile starts from. The
 * vision-impaired profile starts at `VISION_IMPAIRED_WALK_SPEED_MPS` unless
 * the rider already walks slower. Unlike the wheelchair cap this applies only
 * on the switch, so the rider can raise the speed afterwards.
 */
export function resolveWalkParamsOnSwitch(
  profile: MobilityProfile,
  input: WalkParamsInput,
): WalkParams {
  const resolved = resolveWalkParams(profile, input);
  if (profile === "vision_impaired") {
    return {
      ...resolved,
      walkSpeedMps: Math.min(resolved.walkSpeedMps, VISION_IMPAIRED_WALK_SPEED_MPS),
    };
  }
  return resolved;
}

/**
 * The speed a rider walks to and from stops and between them: the wheelchair
 * speed for a wheelchair rider (the reach search has always used it), the
 * rider's own speed otherwise. The entry and exit walks and the engine's
 * transfer walks use this one value, so a journey's walks agree.
 */
export function riderWalkSpeedMps(profile: MobilityProfile | undefined, walkSpeedMps: number): number {
  return profile === "wheelchair" ? WHEELCHAIR_WALK_SPEED_MPS : walkSpeedMps;
}

/**
 * Minimum transfer time per profile, seconds: the engine's floor wherever no
 * GTFS `transfers.txt` rule sets one, and the realtime overlay's test for a
 * broken connection. Every profile uses the engine default until a source
 * supports another figure; a profile changes its own entry here.
 * https://gtfs.org/documentation/schedule/reference/#transferstxt
 */
export const MIN_TRANSFER_SECS_BY_PROFILE: Readonly<Record<MobilityProfile, number>> = {
  default: RAPTOR_MIN_TRANSFER_SECS,
  wheelchair: RAPTOR_MIN_TRANSFER_SECS,
  vision_impaired: RAPTOR_MIN_TRANSFER_SECS,
  bicycle: RAPTOR_MIN_TRANSFER_SECS,
};

export function minTransferSecsFor(profile: MobilityProfile | undefined): number {
  return MIN_TRANSFER_SECS_BY_PROFILE[profile ?? "default"];
}

/**
 * Speed of a rider who is willing to run, derived from their own walking
 * speed so run-to-catch composes with the walk-speed preference instead of
 * overriding it. Shared by the planner's reach (`findReachableStops`) and the
 * route cards' catch advice, which have to agree on what "running" means.
 */
export function runSpeedMps(walkSpeedMps: number): number {
  return Math.min(walkSpeedMps * RUN_TO_CATCH_SPEED_FACTOR, MAX_RUN_SPEED_MPS);
}

/**
 * The engine profile for a rider's profile, for the on-device engine and the
 * remote planner alike. Wheelchair and bicycle change what the engine may
 * board; vision impaired does not (no hard exclusions), so it plans as
 * default. Its slower walking pace travels separately: in the entry and exit
 * walks the caller computed, and as `RaptorQuery.walkSpeedMps` for the
 * engine's transfer walks.
 * The
 * remote planner gets only this functional value, never the rider's profile
 * name.
 * Exhaustive on purpose: a new profile must choose its engine profile here,
 * or the build fails, instead of reaching the engine and failing every plan.
 */
export function engineMobilityProfile(profile: MobilityProfile | undefined): EngineMobilityProfile | undefined {
  switch (profile) {
    case undefined: return undefined;
    case "default": return "default";
    case "wheelchair": return "wheelchair";
    case "bicycle": return "bicycle";
    case "vision_impaired": return "default";
    default: {
      const unhandled: never = profile;
      throw new Error(`no engine profile for mobilityProfile: ${String(unhandled)}`);
    }
  }
}

export function isMobilityProfile(x: unknown): x is MobilityProfile {
  return x === "default" || x === "wheelchair" || x === "vision_impaired" || x === "bicycle";
}

/** Parse an untrusted mobility-profile string; unknown/absent → "default" (engine-parity). */
export function parseMobilityProfile(raw: unknown): MobilityProfile {
  return isMobilityProfile(raw) ? raw : "default";
}

function isPositiveFinite(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}
