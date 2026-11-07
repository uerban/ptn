import { buildInfo } from "../buildInfo.ts";
import { canUse, getNetworkDecision } from "../privacy/canUse.ts";
import { grantFlow, isFlowAvailable } from "../privacy/flowGrants.ts";
import { api } from "./api.ts";
import type { EngineFailureKind } from "./engineFailure.ts";

export interface EngineFailureReport {
  kind: EngineFailureKind;
  appVersion: string;
}

/** The exact payload keys. The consent dialog enumerates these and asserts
 *  the built report's keys deep-equal this set — payload is the source of truth.
 *  `satisfies readonly (keyof EngineFailureReport)[]` structurally pins the tuple
 *  to the interface: a key not on `EngineFailureReport` fails to compile. */
export const ENGINE_FAILURE_REPORT_KEYS = ["kind", "appVersion"] as const satisfies readonly (keyof EngineFailureReport)[];

export function buildEngineFailureReport(kind: EngineFailureKind): EngineFailureReport {
  return { kind, appVersion: buildInfo.version };
}

export const CLIENT_REPORT_FLOW = "operator.client-report";

/** Whether the explicit "Send report" action is offered: the flow can run
 * and the user has not turned it off. */
export function canOfferEngineFailureReport(): boolean {
  return (
    isFlowAvailable(CLIENT_REPORT_FLOW) &&
    getNetworkDecision(CLIENT_REPORT_FLOW).value !== "denied"
  );
}

/** The explicit "Send report" click: it is the deliberate action that allows
 * the report flow, and it sends this one report. */
export async function sendEngineFailureReportOnRequest(
  kind: EngineFailureKind,
): Promise<void> {
  grantFlow(CLIENT_REPORT_FLOW, "contextual");
  await sendEngineFailureReport(kind);
}

/**
 * Fire-and-forget report, sent only while `operator.client-report` is allowed. The flow is
 * granted by an explicit user click, never automatically; this gate is the request-boundary
 * check.
 */
export async function sendEngineFailureReport(kind: EngineFailureKind): Promise<void> {
  // Fail closed: an early-boot read before the decision store initialises can
  // throw — default to NOT sending.
  try {
    if (!canUse(CLIENT_REPORT_FLOW)) return;
  } catch {
    return;
  }
  await api.sendClientReport(buildEngineFailureReport(kind));
}
