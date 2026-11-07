import { useState } from "react";
import {
  canOfferEngineFailureReport,
  ENGINE_FAILURE_REPORT_KEYS,
  sendEngineFailureReportOnRequest,
} from "../../services/engineFailureReport.ts";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";
import type { EngineFailureKind } from "../../services/engineFailure.ts";

const HEADLINE: Record<EngineFailureKind, string> = {
  "no-wasm": "On-device routing isn't available on this device or browser.",
  import: "The routing engine failed to load.",
  init: "The routing engine failed to start.",
  query: "On-device routing hit an error for this trip.",
  other: "On-device routing failed unexpectedly.",
};

/**
 * Honest engine-failure surface. The message + inline diagnostic are ALWAYS shown (the user is
 * never left in the dark). The opt-in "Send report" is offered whenever the report flow can run;
 * clicking it is the explicit action that allows it. The disclosure enumerates exactly the
 * payload keys (payload is the source of truth). The optional "Search on the server" action is shown when `remoteSearch` is
 * present (its presence encodes both the privacy ceiling AND a wired handler).
 */
export function EngineFailureNotice({
  message,
  kind,
  remoteSearch,
}: {
  message: string;
  kind: EngineFailureKind | null;
  /**
 * Present ⇒ remote routing is permitted (privacy ceiling) AND a handler is wired. Presence is
 * the single source of truth for the "Search on the server" affordance.
 */
  remoteSearch?: { onSearchOnServer: () => void };
}) {
  const [sent, setSent] = useState(false);
  const k = kind ?? "other";
  // Re-render when the report decision changes (Settings, another tab).
  useNetworkDecisionsStore((s) => s.decisions);
  const canReport = canOfferEngineFailureReport();

  return (
    <div
      data-testid="engine-error"
      role="alert"
      className="m-3 flex flex-col gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
    >
      <p className="font-medium">{HEADLINE[k]}</p>
      <p data-testid="engine-failure-diagnostic" className="text-xs text-danger/80">
        <code className="rounded bg-danger/10 px-1 font-mono">{k}</code> — {message}
      </p>
      {remoteSearch ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            data-testid="engine-failure-search-server"
            onClick={remoteSearch.onSearchOnServer}
            className="w-full rounded-lg border border-accent py-2 text-sm font-medium text-accent hover:bg-accent/10"
          >
            Search on the server instead
          </button>
          <p className="text-xs text-danger/70">
            Your trip query will leave your device.
          </p>
        </div>
      ) : null}
      {canReport ? (
        <div className="flex flex-col gap-1">
          <p data-testid="engine-failure-disclosure" className="text-xs text-danger/70">
            The report body includes only: {ENGINE_FAILURE_REPORT_KEYS.join(", ")}. Never your
            trip or location. The server can still see normal connection metadata such as your IP
            address and request time.
          </p>
          <button
            type="button"
            data-testid="engine-failure-send"
            disabled={sent}
            onClick={() => {
              void sendEngineFailureReportOnRequest(k);
              setSent(true);
            }}
            className="w-full rounded-lg border border-danger/40 py-2 text-sm text-danger hover:bg-danger/10 disabled:opacity-60"
          >
            {sent ? "Report sent — thank you" : "Send error report to developers"}
          </button>
        </div>
      ) : (
        <p className="text-xs text-danger/70">
          Reporting is off at your privacy level. You can copy the diagnostic above to file an issue.
        </p>
      )}
    </div>
  );
}
