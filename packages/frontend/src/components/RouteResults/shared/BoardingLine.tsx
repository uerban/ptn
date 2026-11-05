import { memo } from "react";
import { useTranslation } from "../../../i18n/index.ts";
import type { Segment } from "./legHelpers.ts";
import { deriveBoarding } from "./boarding.ts";

interface Props {
  segments: Segment[];
  /** Per-variant type scale; the variants disagree about density on purpose. */
  className?: string;
}

/**
 * Which stop this itinerary boards at, and how far it is.
 *
 * Rendered only when the rider has to walk somewhere first. When the trip
 * starts at the boarding stop the origin field above the results already names
 * it, and repeating it on every card buys nothing.
 *
 * Why it exists: two results can leave at the same minute from stops a few
 * hundred metres apart, and the card showed the line and the alight stop but
 * never the boarding stop — so the pair was indistinguishable on screen. The
 * walking total further down is not a substitute: it names no stop, and with a
 * transfer it is not the access distance either.
 *
 * Not `aria-hidden`: the card's `aria-label` already wins over name-from-
 * content, so this is not double-announced today, and leaving it in the
 * accessibility tree keeps the information reachable if that label ever goes.
 */
export const BoardingLine = memo(function BoardingLine({
  segments,
  className = "text-[11px] text-fg-muted",
}: Props) {
  const { t } = useTranslation();
  const boarding = deriveBoarding(segments);
  if (!boarding || boarding.atOrigin) return null;

  const text =
    boarding.meters !== null
      ? t("route.board_from_walk", "From {stop} · {n} m")
          .replace("{stop}", boarding.stopName)
          .replace("{n}", String(boarding.meters))
      : t("route.board_from", "From {stop}").replace(
          "{stop}",
          boarding.stopName,
        );

  return (
    <div data-testid="boarding-line" className={`${className} leading-snug truncate`}>
      {text}
    </div>
  );
});
