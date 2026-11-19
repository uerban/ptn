/**
 * One chip look for the Search header: the time and sort chips, vehicle
 * filters and leave presets. 40 px tall at default text, growing with larger
 * text (no upper cap), with the tap area padded to at least 44 px.
 */
export type SearchChipVariant = "selected" | "idle" | "on" | "off";

const BASE =
  "relative min-h-10 shrink-0 inline-flex items-center gap-1.5 rounded-full border " +
  "text-xs font-semibold leading-tight whitespace-nowrap transition-colors " +
  // Tap area: at least 44 px tall even while the chip draws 40 px.
  "before:absolute before:inset-x-0 before:-inset-y-0.5 before:content-[''] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

const VARIANT: Record<SearchChipVariant, string> = {
  selected: "bg-accent text-badge-text border-accent",
  idle: "bg-input-bg text-fg border-divider hover:border-accent",
  on: "bg-accent/15 text-fg border-accent/50 hover:border-accent",
  // Off is said by strike-through and aria-pressed, not by fading: the
  // label keeps full text contrast.
  off: "bg-surface text-fg-secondary border-divider line-through decoration-2 hover:border-accent",
};

// A badge has no label to strike through, so a line crosses the badge itself.
const BADGE_STRIKE =
  "after:absolute after:inset-x-1.5 after:top-1/2 after:h-0.5 after:-translate-y-1/2 after:-rotate-45 " +
  "after:rounded-full after:bg-fg after:ring-1 after:ring-surface after:content-['']";

export function searchChipClass(variant: SearchChipVariant): string {
  return `${BASE} px-3 ${VARIANT[variant]}`;
}

/** A vehicle filter drawn as its badge alone; the caller names the button. */
export function searchBadgeChipClass(excluded: boolean): string {
  // The tap area also reaches 44 px wide, inside the gap between chips.
  const shape = "min-w-10 justify-center px-1 before:-inset-x-0.5!";
  return excluded ? `${BASE} ${shape} ${VARIANT.off} ${BADGE_STRIKE}` : `${BASE} ${shape} ${VARIANT.on}`;
}
