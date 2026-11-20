/**
 * Route priority in the Search header. Collapsed it is one chip that says the
 * current choice; it opens a sheet with the choices, and picking one applies
 * it and closes the sheet.
 */
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import type { RankingCriteria } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { BottomSheet } from "../Layout/BottomSheet.tsx";
import { searchChipClass } from "./searchChip.ts";

const OPTIONS: readonly (readonly [RankingCriteria, string, string])[] = [
  ["fastest", "search.fastest", "Fastest"],
  ["fewest_transfers", "search.fewest_transfers", "Fewest transfers"],
  ["least_walking", "search.least_walking", "Least walking"],
];

interface SortChipProps {
  readonly arriveBy?: boolean;
  readonly value: RankingCriteria;
  readonly onChange: (value: RankingCriteria) => void;
}

export function SortChip({ value, onChange, arriveBy = false }: SortChipProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const current = OPTIONS.find(([option]) => option === value) ?? OPTIONS[0];
  const sortLabel = arriveBy
    ? t("search.sort_tie_breaker", "Tie-breaker")
    : t("search.sort", "Sort");

  return (
    <>
      <button type="button" className={`${searchChipClass("idle")} min-w-0 max-w-max shrink! grow basis-40`} data-testid="sort-summary"
        aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0 text-accent">
          <path d="M7 4v16M7 4l-3 3M7 4l3 3" /><path d="M17 20V4M17 20l-3-3M17 20l3-3" />
        </svg>
        <span className="min-w-0 whitespace-normal text-left">{sortLabel}: {t(current[1], current[2])}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={`shrink-0 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          {/* Backdrop: a tap outside closes, like Esc. Not a tab stop. */}
          <button type="button" tabIndex={-1} aria-hidden="true" data-testid="sort-backdrop"
            className="absolute inset-0 bg-black/40" onClick={close} />
          <BottomSheet onClose={close} height="full" ariaLabel={sortLabel} data-testid="sort-sheet"
            className="relative flex max-h-[85dvh] flex-col rounded-t-2xl bg-surface-raised text-fg shadow-lg">
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-[min(1rem,16px)] pt-3 pb-2">
              <h2 className="text-base font-semibold">{sortLabel}</h2>
              <p className="text-sm text-fg-secondary">
                {arriveBy
                  ? t("search.sort_arrive_by_help", "Journeys with the latest departure appear first. This preference breaks departure-time ties between the remaining journeys.")
                  : t("search.sort_departure_help", "This preference ranks the journeys found. You may see the same journey under every preference.")}
              </p>
              <div className="space-y-1" role="group" aria-label={sortLabel}>
                {OPTIONS.map(([option, key, fallback]) => {
                  const active = option === value;
                  return (
                    <button key={option} type="button" aria-pressed={active} data-testid={`sort-${option}`}
                      className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                        active ? "bg-accent text-badge-text" : "text-fg hover:bg-surface-overlay"}`}
                      onClick={() => { onChange(option); close(); }}>
                      <span className="min-w-0">{t(key, fallback)}</span>
                      {active && (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
                          <path d="m5 12 5 5L20 7" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Sticky footer: the way out is always on screen. */}
            <div className="border-t border-divider px-[min(1rem,16px)] py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <button type="button" onClick={close} data-testid="sort-close"
                className="min-h-11 w-full rounded-lg border border-divider px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                {t("trip.close", "Close")}
              </button>
            </div>
          </BottomSheet>
        </div>,
        document.body,
      )}
    </>
  );
}
