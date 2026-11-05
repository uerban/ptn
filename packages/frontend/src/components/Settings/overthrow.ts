// About-card easter egg. The Settings version block is the only interactive
// target in that card, and one click counter drives the whole ladder: the
// first click only copies the build info, the 2nd and every click after it
// flash HU/LO next to the PTN name, the 10th reveals the overthrow line, and
// every click past that re-rolls both lines. Nothing is rendered before the
// reveal, so the first line a user ever sees is already randomised — there is
// no fixed opening message.
//
// The HU/LO gate is a click COUNT, not a timed double-click: this is a
// mobile-first PWA, and a fast double-tap is exactly the gesture phone
// browsers swallow for zoom heuristics and the legacy 300 ms tap delay. A
// count behaves identically on touch, mouse, and keyboard.

export const OVERTHROW_LABELS_TIER1 = [
  "Attempting to dethrone PTN...",
  "Attempting to depose PTN...",
  "Attempting to overthrow PTN...",
  "Attempting to exile PTN...",
  "Attempting to defenestrate PTN...",
  "Attempting to impeach PTN...",
  "Attempting to indict PTN...",
  "Attempting to retire PTN to a quiet dacha...",
  "Attempting to vote PTN out...",
  "Sending PTN to Hague...",
  "Filing charges against PTN at the ICC...",
] as const;

export const OVERTHROW_LABELS_TIER2 = [
  "Attempting to assassinate PTN...",
  "Attempting to decapitate PTN...",
  "Attempting to liquidate PTN...",
  "Attempting to guillotine PTN...",
] as const;

export const OVERTHROW_RESPONSES = [
  "...failed. The throne still stands — but the world keeps turning.",
  "...failed. Many have tried before. The work continues.",
  "...failed. Not today, but not the end of days either.",
  "...failed. Buttons cannot do this work alone — yet here we are.",
  "...failed. The crown holds, for now. Hope outlives the hopeful.",
  "...failed. The wheel turns slowly, but it turns.",
  "...failed. Time, however, has a long memory.",
  "...failed. Perhaps tomorrow. Or the day after. It will come.",
  "...failed. Patience — empires have ended over less.",
  "...failed. The quiet dacha awaits, sooner or later.",
  // Breaks the "...failed." cadence on purpose — it used to be the fixed
  // opening subtext, kept here so it can still turn up, just not every time.
  "i wish it would be that easy in reality",
] as const;

export const HUYLO_FLASH_LABEL = "HU/LO";
export const HUYLO_FLASH_MS = 2500;

/** Click count at which HU/LO starts flashing. Click 1 is a plain copy. */
export const HUYLO_REVEAL_THRESHOLD = 2;

export const OVERTHROW_REVEAL_THRESHOLD = 10;
export const OVERTHROW_TIER2_THRESHOLD = 20;

export interface OverthrowLine {
  label: string;
  subtext: string;
}

/** Random pick that never repeats `prev`, so each click visibly changes the line. */
export function pickDifferent(pool: readonly string[], prev: string | null): string {
  const candidates = pool.filter((m) => m !== prev);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Line to show after `clickCount` clicks on the version block, or `null` while
 * the easter egg is still hidden. `prev` is the currently-shown line; both
 * halves are re-rolled away from it so no click is a visual no-op.
 */
export function nextOverthrowLine(
  clickCount: number,
  prev: OverthrowLine | null,
): OverthrowLine | null {
  if (clickCount < OVERTHROW_REVEAL_THRESHOLD) return null;
  const labelPool =
    clickCount >= OVERTHROW_TIER2_THRESHOLD
      ? [...OVERTHROW_LABELS_TIER1, ...OVERTHROW_LABELS_TIER2]
      : OVERTHROW_LABELS_TIER1;
  return {
    label: pickDifferent(labelPool, prev?.label ?? null),
    subtext: pickDifferent(OVERTHROW_RESPONSES, prev?.subtext ?? null),
  };
}
