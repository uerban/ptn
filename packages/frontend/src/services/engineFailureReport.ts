import { buildInfo } from "../buildInfo.ts";
import { getPolicy } from "../stores/privacyStore.ts";
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

/**
 * Fire-and-forget opt-in report. Honors the `errorReporting` privacy axis: at
 * hardened/strict/paranoid (floored false) nothing is sent. The caller (the UI) only invokes
 * this on an explicit user click; this gate is the second line of defense, not the consent
 * itself.
 */
export async function sendEngineFailureReport(kind: EngineFailureKind): Promise<void> {
  // Fail closed: an early-boot read before the privacy store initialises can
  // throw — default to NOT sending, mirroring errorReporter.ts's readPolicySafely.
  try {
    if (!getPolicy().errorReporting) return;
  } catch {
    return;
  }
  await api.sendClientReport(buildEngineFailureReport(kind));
}
