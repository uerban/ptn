import { useTranslation } from "../../../i18n/index.ts";
import { formatTime } from "./format.ts";

interface ShouldShowArgs {
  leadingWaitSeconds: number;
  bufferSeconds: number;
  /** Higher-priority callout: miss-risk on the card. Suppresses banner. */
  missRisk: boolean;
  /** Higher-priority callout: live delay on the card. Suppresses banner. */
  hasLiveDelay: boolean;
}

/**
 * Strict-greater-than threshold: show banner only when leading wait exceeds
 * `max(5 min, bufferSeconds + 2 min)`. Wheelchair / vision_impaired profiles
 * (300s buffer) raise the floor to 7 min so users with longer buffers still
 * get the banner for genuinely-far-away buses.
 *
 * Priority: miss-risk > live-delay > leading-wait. When higher-priority
 * callouts are showing, suppress the banner — the LeaveHint and bar
 * segment still carry the info at lower priority.
 */
export function shouldShowLeadingWaitBanner(args: ShouldShowArgs): boolean {
  if (args.missRisk || args.hasLiveDelay) return false;
  const floor = Math.max(300, args.bufferSeconds + 120);
  return args.leadingWaitSeconds > floor;
}

interface Props {
  firstTransitDepMs: number;
  referenceNowMs: number;
  recommendedDepartureMs: number;
  /** Feed/agency tz for the leave time; device tz when omitted (local-user path). */
  feedTz?: string;
}

/**
 * Informational banner shown on the Consumer card when the leading wait is
 * substantial. Tone matches the existing live-delay callout (no border, no
 * warning colour). The leave time is bolded for emphasis; the rest is
 * `text-fg-muted` to avoid elevating to a warning-priority callout.
 *
 * Copy: `Next departure in {n} min. Leave at {time}.`
 *   - {n} = ceil((firstTransitDep − referenceNow) / 60) — "next bus" semantics
 *   - {time} = formatTime(recommendedDepartureMs)
 *
 * No `aria-live` / `role="status"` — visual-only; the card's own aria-label
 * is the canonical screen-reader path.
 */
export function LeadingWaitBanner({
  firstTransitDepMs,
  referenceNowMs,
  recommendedDepartureMs,
  feedTz,
}: Props) {
  const { t, formattingLocale } = useTranslation();
  const deltaMs = firstTransitDepMs - referenceNowMs;
  // Hard guard: callers should have gated on `hideBufferChrome` before
  // rendering this banner. If they didn't (a stale memo, a future caller
  // missing the gate, or NaN from parseFailed slipping through), bail
  // out — silently rendering "Next departure in 0 min." or "NaN min." would
  // contradict the bar and confuse the user.
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[LeadingWaitBanner] called with invalid timing — caller should have gated on hideBufferChrome",
        { firstTransitDepMs, referenceNowMs },
      );
    }
    return null;
  }
  const nMin = Math.ceil(deltaMs / 60000);
  const leaveTime = formatTime(
    new Date(recommendedDepartureMs).toISOString(),
    formattingLocale,
    feedTz,
  );
  const copy = t(
    "route.leading_wait_banner",
    "Next departure in {n} min. Leave at {time}.",
  ).replace("{n}", String(nMin));
  const [before, after] = copy.split("{time}");
  return (
    <div className="flex items-start gap-2 rounded-lg bg-accent/10 px-2.5 py-1.5 text-[11px] leading-snug text-fg-muted">
      <span aria-hidden className="text-accent">
        ⓘ
      </span>
      <span>
        {before}
        <b className="text-fg">{leaveTime}</b>
        {after ?? ""}
      </span>
    </div>
  );
}
