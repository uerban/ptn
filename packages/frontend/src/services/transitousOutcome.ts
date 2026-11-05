import { HttpError, BackendStartingError } from "./api.ts";
import type { TransitousItinerary } from "./transitousResult.ts";

/**
 * The four mutually-exclusive remote outcomes. No silent failures. `results` carries a
 * NON-EMPTY itinerary list (a one-plus tuple) so an empty `results` is unrepresentable and the
 * panel's `itineraries[0]` is provably safe (this repo builds with `noUncheckedIndexedAccess`
 * off).
 */
export type TransitousOutcome =
  | { kind: "results"; itineraries: [TransitousItinerary, ...TransitousItinerary[]] }
  | { kind: "empty" }
  | { kind: "failure" }
  | { kind: "offline" };

export function classifyTransitousResult(itineraries: TransitousItinerary[]): TransitousOutcome {
  const [first, ...rest] = itineraries;
  return first !== undefined ? { kind: "results", itineraries: [first, ...rest] } : { kind: "empty" };
}

/**
 * A 429/5xx/4xx/malformed/startup error is a FAILURE (never masked as offline).
 * A timeout (AbortError) or a bare network TypeError is OFFLINE only when the
 * device reports offline; otherwise it too is a failure (server unreachable
 * while we DO have a connection).
 */
export function classifyTransitousError(err: unknown, online: boolean): TransitousOutcome {
  // A server response we DID receive (429 / 5xx / 4xx / malformed / startup) is
  // a failure — never masked as offline.
  if (err instanceof HttpError || err instanceof BackendStartingError) {
    return { kind: "failure" };
  }
  // No response: a timeout (AbortError) or a bare network error. Honest
  // "offline" only when the device reports offline; otherwise the server is
  // unreachable while we DO have a connection, which is a failure.
  return online ? { kind: "failure" } : { kind: "offline" };
}
