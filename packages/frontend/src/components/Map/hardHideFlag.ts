/**
 * Stop-card hard-hide kill-switch resolution.
 *
 * Stage 1b flipped the DEFAULT to ON (hide-rather-than-overlap): a non-selected
 * card with no overlap-free position is hidden and its dot dims, instead of
 * stacking cards. Stage 2's road-aware placement means far fewer cards hit this.
 *
 * Rollback levers ("switch back anytime") — any value OTHER than the exact
 * string `"0"` (including unset) leaves it ON:
 *   - per-user, instant (no redeploy):  localStorage `ptn.hardHideLabels = "0"`
 *   - deploy-wide:                       env `VITE_PT_HARD_HIDE_LABELS = "0"`
 *
 * Pure + storage/env-injected so the default + both rollback paths are unit-testable
 * (the live call in `TransitMap` passes `localStorage` + `import.meta.env`).
 */
export function hardHideLabelsEnabled(
  ls: Pick<Storage, "getItem"> | undefined,
  envValue: string | undefined,
): boolean {
  const lsOptOut = ls?.getItem("ptn.hardHideLabels") === "0";
  const envOptOut = envValue === "0";
  return !lsOptOut && !envOptOut;
}
