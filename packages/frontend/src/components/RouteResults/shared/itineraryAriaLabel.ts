import type { Itinerary } from "@pt/shared";
import { pluralize } from "../../../i18n/plurals.ts";
import { modeLabel } from "../../../utils/modeLabels.ts";
import { formatTime, toMinutes } from "./format.ts";
import { peakDelayMinutes, transferRisk } from "./legHelpers.ts";
import { shownTripSpan, type ItineraryDisplay } from "./itineraryDisplay.ts";
import { deriveBoarding } from "./boarding.ts";

type Translate = (key: string, fallback?: string) => string;

export interface ItineraryAriaLabelContext {
  t: Translate;
  /** Plural-rule locale (the UI locale), not the formatting locale. */
  locale: string;
  /** BCP-47 tag used for time formatting. */
  formattingLocale: string;
  /** Anchor for the "leave in N min" cue — the same value the card renders with. */
  referenceNowMs: number;
  /** Feed/agency tz (IANA); when set, the arrival time renders in the feed tz. */
  feedTz?: string;
  /** Marks the card the variant renders with the "fastest" chrome. */
  fastest?: boolean;
  /** Minutes until the same line next leaves, when this departure is a likely miss. */
  nextDepartureInMin?: number | null;
}

/**
 * Longest countdown still worth announcing as "Leave in N min"; above this the
 * cue switches to an absolute clock time.
 */
const COUNTDOWN_CEILING_MIN = 60;

/** Drop a trailing sentence period so joining never produces "..". */
function clause(s: string): string {
  return s.trim().replace(/[.。]+$/, "");
}

/**
 * Build the single accessible name for an itinerary card.
 *
 * Why an author-supplied name at all: every variant's card is one `<button>`,
 * and a button is a leaf in the accessibility tree — VoiceOver concatenates
 * the whole subtree into one utterance with no way to stop partway. Left to
 * name-from-content that utterance follows the *visual* order (fastest chrome,
 * big duration numeral, badge glyphs, per-leg rows, live callouts), so the
 * rider has to sit through the entire card before hearing whether they need to
 * move. `aria-label` wins over name-from-content, which lets us order the same
 * facts by how soon the rider needs them:
 *
 *   1. anything that invalidates the trip (cancelled / miss risk / live delay)
 *   2. "Fastest", the ranking cue that decides which card to take
 *   3. when to start walking
 *   4. what to board and where to get off
 *   5. how long it takes and when it lands
 *   6. transfer count and walking distance
 *
 * A rider can act on the first two clauses and let the rest play out.
 *
 * Pure: takes the already-derived `ItineraryDisplay` rather than re-deriving,
 * so the label can never disagree with the chrome the card rendered.
 */
export function itineraryAriaLabel(
  it: Itinerary,
  display: ItineraryDisplay,
  ctx: ItineraryAriaLabelContext,
): string {
  const { t, locale, formattingLocale, referenceNowMs, feedTz, fastest } = ctx;
  const parts: string[] = [];

  // 1. Trust / urgency. At most one fires — these are ordered by how badly
  //    they invalidate the plan, matching the card chrome's own precedence
  //    (cancelled outranks unreliable; see RouteResultsConsumer).
  const risk = transferRisk(display.segments);
  const liveDelay = peakDelayMinutes(it);
  if (it.cancelled === true || display.catchStatus === "cancelled") {
    parts.push(t("rt.cancelled_warning", "Trip is cancelled"));
  } else if (display.catchStatus === "removed") {
    parts.push(t("route.aria_removed", "No longer scheduled"));
  } else if (risk === "miss") {
    parts.push(
      t("route.may_miss", "Live delay may cause you to miss a transfer."),
    );
  } else if (it.timingUnreliable === true) {
    parts.push(t("rt.timing_unreliable_warning", "Trip has unreliable timing"));
  } else if (liveDelay.minutes >= 2) {
    parts.push(
      [
        t("route.live_update_line", "Live:"),
        liveDelay.line ?? "",
        t("route.running_late", "is running +{min} min").replace(
          "{min}",
          String(liveDelay.minutes),
        ),
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  // 2. Ranking cue.
  if (fastest) parts.push(t("route.aria_fastest", "Fastest"));

  // 3. When to move. Derived from recommendedDepartureMs (not
  //    leadingWaitSeconds) so a rider who turned the pre-stop buffer off still
  //    hears the real countdown to setting off (first departure less the walk
  //    to the stop) rather than "Leave now".
  //
  //    Past COUNTDOWN_CEILING_MIN the countdown stops being an instruction and
  //    starts being arithmetic to listen to: a search for tonight, or a few
  //    taps on "Later", can put the first departure hours out, and "Leave in
  //    412 min" is a worse utterance than the clock time. Same cutover the
  //    visible LeaveHint makes, and the same limitation — a leave time more
  //    than a day out is announced without its date.
  //
  //    A catch problem replaces the cue outright, as it does on the visible
  //    hint: "Leave now" is not the instruction for a bus only a run makes.
  if (display.catchStatus === "cancelled" || display.catchStatus === "removed") {
    // "Trip is cancelled" / "No longer scheduled" already leads; what to do
    // instead follows.
    if (typeof ctx.nextDepartureInMin === "number") {
      parts.push(
        t("route.aria_cancelled_next", "Next departure in about {n} min").replace(
          "{n}",
          String(ctx.nextDepartureInMin),
        ),
      );
    }
  } else if (display.catchStatus === "tight") {
    parts.push(t("route.aria_leave_now_tight", "Leave now, no time to spare"));
  } else if (display.catchStatus === "hurry") {
    parts.push(t("route.aria_leave_hurry", "Leave now and hurry to make it"));
  } else if (display.catchStatus === "likely-miss") {
    parts.push(
      typeof ctx.nextDepartureInMin === "number"
        ? t(
            "route.aria_likely_miss_next",
            "Likely to miss this departure, next in about {n} min",
          ).replace("{n}", String(ctx.nextDepartureInMin))
        : t("route.aria_likely_miss", "Likely to miss this departure"),
    );
  } else if (!display.parseFailed && !display.alreadyDeparted) {
    const leaveInMin = Math.round(
      (display.recommendedDepartureMs - referenceNowMs) / 60000,
    );
    if (leaveInMin <= 0) {
      parts.push(t("route.aria_leave_now", "Leave now"));
    } else if (leaveInMin <= COUNTDOWN_CEILING_MIN) {
      parts.push(
        t("route.aria_leave_in", "Leave in {n} min").replace(
          "{n}",
          String(leaveInMin),
        ),
      );
    } else {
      parts.push(
        t("route.aria_leave_at", "Leave at {time}").replace(
          "{time}",
          formatTime(
            new Date(display.recommendedDepartureMs).toISOString(),
            formattingLocale,
            feedTz,
          ),
        ),
      );
    }
  }

  // 4. Where to board. Two results can leave at the same minute from stops a
  //    few hundred metres apart, and until the rider hears which stop — and how
  //    far it is — the cards are indistinguishable by ear. The itinerary already
  //    encodes the answer: a leading non-transfer walk means the trip starts
  //    somewhere other than the boarding stop (a pin, an address, or the far
  //    side of the road from a same-named stop), so the name alone would not
  //    disambiguate and the distance has to come with it. A trip whose first
  //    segment is the ride starts at the boarding stop, and there the long form
  //    is noise — "Board here" is the whole message.
  const rides = display.segments.filter((s) => s.kind === "ride");
  //    `deriveBoarding` owns the shape analysis, and the visible BoardingLine
  //    reads the same function — the announcement and the card cannot disagree
  //    about which stop is boarded.
  const boarding = deriveBoarding(display.segments);
  if (boarding) {
    if (boarding.atOrigin) {
      parts.push(t("route.aria_board_here", "Board here"));
    } else if (boarding.meters !== null) {
      parts.push(
        t("route.aria_board_at", "Board at {stop}, {n} m")
          .replace("{stop}", boarding.stopName)
          .replace("{n}", String(boarding.meters)),
      );
    } else {
      parts.push(
        t("route.aria_board_at_plain", "Board at {stop}").replace(
          "{stop}",
          boarding.stopName,
        ),
      );
    }
  }

  // 5. What to ride, and where to get off. Walks are omitted — the rider needs
  //    the vehicle chain to act; walking totals come in the last clause.
  if (rides.length === 0) {
    parts.push(
      t("route.aria_walk_leg", "walk {n} min").replace(
        "{n}",
        String(toMinutes(it.durationSeconds)),
      ),
    );
  } else {
    const then = t("route.aria_then", "then");
    parts.push(
      rides
        .map((s, i) => {
          const leg = s.leg;
          const name = modeLabel(t, leg.mode);
          const vehicle = leg.routeShortName
            ? `${name} ${leg.routeShortName}`
            : name;
          const hop = t("route.aria_leg", "{vehicle} to {stop}")
            .replace("{vehicle}", vehicle)
            .replace("{stop}", leg.to.name);
          return i === 0 ? hop : `${then} ${hop}`;
        })
        .join(", "),
    );
  }

  // 6. Shape of the trip — counted from the leave time, like the card header.
  const span = shownTripSpan(it, display);
  parts.push(
    t("route.aria_duration_arrival", "{n} min, arrives {time}")
      .replace("{n}", String(toMinutes(span.durationSeconds)))
      .replace("{time}", formatTime(span.arrivalTime, formattingLocale, feedTz)),
  );

  // 7. Cost of the trip — last, because it rarely changes the decision once
  //    the clauses above have been heard.
  const meta = [
    `${it.transfers} ${pluralize(
      locale,
      it.transfers,
      t("route.transfer_one", "transfer"),
      t("route.transfer_few", "transfers"),
      t("route.transfer_many", "transfers"),
    )}`,
  ];
  // The access walk already stated its distance. When it accounts for
  //    essentially all the walking — the common single-leg case — repeating the
  //    same number as a total is pure duplication in an utterance that is
  //    already long, so it is dropped rather than restated.
  const walkMeters = Math.round(it.walkingDistanceMeters);
  const accessCoversWalk =
    boarding !== null &&
    boarding.meters !== null &&
    Math.abs(walkMeters - boarding.meters) <= 5;
  if (walkMeters > 0 && !accessCoversWalk) {
    meta.push(
      t("route.aria_walking_total", "{n} m walking").replace(
        "{n}",
        String(walkMeters),
      ),
    );
  }
  parts.push(meta.join(", "));

  return `${parts.map(clause).filter(Boolean).join(". ")}.`;
}
