import type { Itinerary, Leg, LatLon } from "./transit.js";

export type LegStatus = "completed" | "current" | "upcoming" | "future";
export type GuidancePhase = "idle" | "navigating" | "riderMode";
export type RiderModeActivation = "manual" | "navigation" | "stopContext";

export interface RiderCandidate {
  tripId: string;
  routeShortName: string;
  headsign: string;
  departureTime: string;
  routeColor?: string;
}

/** The next walking instruction ahead of the rider (walk-graph routes only). */
export interface WalkingNextStep {
  kind: "turn" | "cross" | "stairs" | "arrive";
  /** WalkTurn wire string (e.g. "left", "slight-right"). On "turn"; on
   *  "cross" / "stairs" only when the path turns onto them. */
  turn?: string;
  /** Street name, or "" when unnamed. */
  name: string;
  /** Metres from the rider's position to where the step begins. */
  distanceToStartMeters: number;
}

export interface WalkingProgress {
  distanceRemainingMeters: number;
  estimatedSecondsRemaining: number;
  bearingDegrees: number | null;
  /** Share of the leg still ahead, 0..1 — scales the leg's own planned duration. */
  remainingFraction?: number;
  /** Present when the leg has a walk-graph route. */
  nextStep?: WalkingNextStep;
}

export interface TransitProgress {
  currentStopName: string | null;
  stopsRemaining: number;
  delaySeconds: number;
}

export interface GuidanceSnapshot {
  phase: GuidancePhase;
  itinerary: Itinerary | null;
  currentLegIndex: number;
  legStatuses: LegStatus[];
  walkingProgress: WalkingProgress | null;
  transitProgress: TransitProgress | null;
  riderModeActivation: RiderModeActivation | null;
  riderTripId: string | null;
}

export interface UpcomingStop {
  name: string;
  id: string;
}

export interface ConnectingDeparture {
  routeShortName: string;
  headsign: string;
  minutesUntil: number;
  // True when the underlying next-departure was resolved via a route's
  // direction pattern rather than its canonical stop sequence — the
  // minute count is positional rather than exact. Rendered as a `~`
  // prefix on the dashboard chip.
  isApproximate?: boolean;
}

export interface ConnectionAtStop {
  stopName: string;
  departures: ConnectingDeparture[];
}
