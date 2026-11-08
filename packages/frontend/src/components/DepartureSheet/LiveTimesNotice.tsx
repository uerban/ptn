import { useEffect, useRef, useState } from "react";
import type { Departure } from "@pt/shared";
import { REALTIME_POLL_INTERVAL_MS } from "@pt/shared/constants";
import { useTranslation } from "../../i18n/index.ts";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import { useCanUse } from "../../privacy/canUse.ts";
import { REALTIME_FLOW } from "../../services/departuresPolicy.ts";
import { useRealtimeKindStatus } from "../../services/realtimeAvailability.ts";
import { FlowDisclosure } from "../Privacy/FlowDisclosure.tsx";

/** Asking surface, for the session's **Not now** memory. */
export const LIVE_TIMES_SURFACE = "departure-sheet";

/** Live times older than this read as possibly out of date: two missed polls. */
export const LIVE_STALE_AFTER_MS = 2 * REALTIME_POLL_INTERVAL_MS + 5_000;

export interface LiveTimesNoticeProps {
  cityId: string;
  cityName: string;
  departures: readonly Departure[];
  loading: boolean;
  /** No timetable on the device and no live source: nothing to show. */
  unavailable: boolean;
  /** When the list on screen was fetched. */
  updatedAt: number | null;
}

type Kind = "scheduled-ask" | "not-offered" | "none-reported" | "stale" | "unavailable" | null;

/**
 * Says which kind of times the departure sheet shows: scheduled (with
 * **Show live times** while live departures are not allowed), live but
 * possibly out of date, or nothing at all. Live times that are current need
 * no line here: the header's LIVE badge and the rows already show them.
 *
 * **Show live times** is the deliberate action for live departures, which
 * otherwise poll unnoticed. It opens the contextual prompt (Allow / Not now
 * / Don't ask again). After **Don't ask again** the button stays, and opens
 * the prompt with Allow. Nothing here is a live region: updates are not
 * announced.
 */
export function LiveTimesNotice({
  cityId,
  cityName,
  departures,
  loading,
  unavailable,
  updatedAt,
}: LiveTimesNoticeProps) {
  const text = usePresentationText();
  const { formattingLocale } = useTranslation();
  const allowed = useCanUse(REALTIME_FLOW);
  const offered = useRealtimeKindStatus(cityId, "departures");
  const [asking, setAsking] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  // Back on the button once the prompt closes (it is rendered again then).
  useEffect(() => {
    if (asking || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    buttonRef.current?.focus();
  }, [asking]);
  const hasLive = departures.some((d) => d.predictedTime);
  const now = useMinuteClock(allowed && hasLive);

  let kind: Kind = null;
  if (unavailable && !loading) {
    kind = "unavailable";
  } else if (offered === "unavailable") {
    kind = "not-offered";
  } else if (!allowed) {
    kind = "scheduled-ask";
  } else if (!loading && departures.length > 0) {
    if (!hasLive) kind = "none-reported";
    else if (updatedAt !== null && now - updatedAt > LIVE_STALE_AFTER_MS) kind = "stale";
  }
  if (kind === null) return null;
  // The way to live times, wherever the city offers them and they are off.
  const canAsk = !allowed && offered !== "unavailable";

  const updated =
    updatedAt !== null
      ? new Date(updatedAt).toLocaleTimeString(formattingLocale, {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";

  return (
    <div data-testid="live-times-notice" data-state={kind}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs text-fg-secondary">
        <p>
          {kind === "stale" ? (
            text("liveTimes.stale", { time: updated })
          ) : (
            <>
              <span className="font-medium text-fg">
                {kind === "unavailable"
                  ? text("liveTimes.unavailable")
                  : text("liveTimes.scheduled")}
              </span>
              {kind === "not-offered" && (
                <span> · {text("liveTimes.notOffered", { city: cityName })}</span>
              )}
              {kind === "none-reported" && (
                <span> · {text("liveTimes.noneReported")}</span>
              )}
            </>
          )}
        </p>
        {canAsk && !asking && (
            <button
              ref={buttonRef}
              type="button"
              data-testid="show-live-times"
              onClick={() => setAsking(true)}
              className="min-h-9 px-3 rounded-lg border border-divider text-xs font-medium text-accent"
            >
              {text("liveTimes.show")}
            </button>
          )}
      </div>
      {asking && (
        <FlowDisclosure
          flowId={REALTIME_FLOW}
          surface={LIVE_TIMES_SURFACE}
          variant="inline"
          heading={text("liveTimes.heading")}
          allowLabel={text("liveTimes.show")}
          details={<p>{text("liveTimes.details")}</p>}
          onClose={() => {
            restoreFocusRef.current = true;
            setAsking(false);
          }}
        />
      )}
    </div>
  );
}

/** Current time, refreshed every 15 s while `active`; otherwise frozen. */
function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
