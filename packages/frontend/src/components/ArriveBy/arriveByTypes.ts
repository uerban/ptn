import type { FirstRideConstraint } from "@pt/shared";
import type { ReactNode } from "react";
import type { BaseEndpoint, Itinerary } from "@pt/shared";

/** Props Search hands the Arrive-by toolbar. */
export interface ArriveByToolbarProps {
  readonly origin: BaseEndpoint | null;
  readonly destination: BaseEndpoint | null;
  /** The Recommended list Search shows; a new array is a new result. */
  readonly recommended: readonly Itinerary[];
  /** True when that list is the initial page (no Earlier/Later move). */
  readonly recommendedInitial: boolean;
  /** The rider chose when to leave (null: now); Search plans from that time. */
  /** The time Search plans from now (null: now); Earlier/Later move it. */
  readonly departAt?: Date | null;
  readonly onDepartAt?: (at: Date | null) => void;
  /** Search's sort chip; it shares the row of the time summary. */
  readonly sort?: ReactNode;
  readonly arriveBySort?: ReactNode;
  /** Search's vehicle filter chips, on the row below. */
  readonly filters?: ReactNode;
}

/** Props Search hands the Arrive-by results. */
export interface ArriveByResultsProps {
  readonly origin: BaseEndpoint | null;
  readonly destination: BaseEndpoint | null;
  readonly onSelect: (itinerary: Itinerary) => void;
  readonly findDifferentPlans?: (at: Date, signal: AbortSignal, excludeRouteId: string, arriveByMs?: number, shownRoutes?: readonly string[]) => Promise<Itinerary[]>;
  readonly findLaterPlans?: (at: Date, signal: AbortSignal, firstRide: FirstRideConstraint & { direct: boolean }) => Promise<Itinerary[]>;
  /** Search's normal results, shown while no arrive-by deadline is applied. */
  readonly children: ReactNode;
}
