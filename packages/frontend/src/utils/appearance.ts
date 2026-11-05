import type { MobilityProfile } from "@pt/shared";
import type { RouteSearchVariant } from "../stores/settingsStore.ts";

export type BadgeSize = "sm" | "md" | "lg";

const BADGE_SIZE: Readonly<Record<RouteSearchVariant, BadgeSize>> =
  Object.freeze({ consumer: "md", power: "sm", accessible: "lg" });

const BADGE_MIN_WIDTH: Readonly<Record<RouteSearchVariant, string>> =
  Object.freeze({ consumer: "2.25rem", power: "1.75rem", accessible: "3rem" });

/** Frozen lookup — return value is referentially stable across calls with the same input. */
export function getBadgeSize(v: RouteSearchVariant): BadgeSize {
  return BADGE_SIZE[v];
}

/** Frozen lookup — return value is referentially stable. */
export function getBadgeMinWidth(v: RouteSearchVariant): string {
  return BADGE_MIN_WIDTH[v];
}

/**
 * One cross-axis coupling, centralised here: `vision_impaired` auto-upgrades
 * to the accessible density regardless of the user's explicit `variant` pick.
 * Other mobility profiles (including wheelchair) honour the explicit choice.
 */
export function effectiveVariant(
  selected: RouteSearchVariant,
  mobility: MobilityProfile,
): RouteSearchVariant {
  return mobility === "vision_impaired" ? "accessible" : selected;
}
