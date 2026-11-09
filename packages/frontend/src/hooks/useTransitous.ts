import { useCallback, useEffect, useRef, useState } from "react";
import { isDeviceOnline } from "./useConnectivity.ts";
import { reportTelemetry } from "../services/errorReporter.ts";
import { planViaTransitous, type TransitousPlanArgs } from "../services/transitousClient.ts";
import { mapTripResult } from "../services/transitousResult.ts";
import { RoutingNotAllowedError } from "../services/routingSource.ts";
import {
  classifyTransitousResult,
  classifyTransitousError,
  type TransitousOutcome,
} from "../services/transitousOutcome.ts";

export type TransitousState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; outcome: TransitousOutcome };

/** Standing-provider transitous state machine: idle → pending → done(outcome).
 * The panel dispatches `run` automatically after Settings has selected the
 * provider; the same function re-fires for failure/offline retry. */
export function useTransitous() {
  const [state, setState] = useState<TransitousState>({ status: "idle" });
  const latestRunRef = useRef(0);

  useEffect(
    () => () => {
      latestRunRef.current += 1;
    },
    [],
  );

  const run = useCallback(async (args: TransitousPlanArgs) => {
    const runId = ++latestRunRef.current;
    setState({ status: "pending" });
    let outcome: TransitousOutcome;
    try {
      const result = await planViaTransitous(args);
      outcome = classifyTransitousResult(mapTripResult(result));
    } catch (err) {
      if (err instanceof RoutingNotAllowedError) {
        // The call-time double-gate backstop refused egress (render-time gating
        // went stale). This is NOT a transient reach failure — never present a
        // "try again". Reset to idle; Search re-renders with the gate now closed
        // and stops offering the action (the panel unmounts).
        if (runId === latestRunRef.current) setState({ status: "idle" });
        return;
      }
      outcome = classifyTransitousError(err, isDeviceOnline());
    }
    // `reportTelemetry` self-gates on the `errorReporting` policy axis and never
    // throws (errorReporter.ts), and `setState` cannot throw — so the terminal
    // `done` always lands and `run` can never strand the panel on the spinner.
    // The payload carries only the outcome `kind` — no coordinates leave here.
    reportTelemetry("transitous_action", { outcome: outcome.kind });
    if (runId === latestRunRef.current) setState({ status: "done", outcome });
  }, []);

  return { state, run };
}
