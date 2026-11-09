import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Itinerary } from "@pt/shared";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import {
  beginTrip,
  pendingTripStartPrompts,
  type TripStartPrompts,
} from "../../services/tripStart.ts";

interface TripStartExplainerProps {
  prompts: TripStartPrompts;
  onStart: () => void;
  onCancel: () => void;
}

/**
 * Explains, at trip start, the permission requests the browser is about to
 * show: location for guidance progress, notifications for get-off alerts.
 */
export function TripStartExplainer({ prompts, onStart, onCancel }: TripStartExplainerProps) {
  const text = usePresentationText();
  const headingId = useId();
  const startRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    startRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid="trip-start-explainer"
        className="w-full max-w-md rounded-2xl bg-surface-raised p-4 shadow-2 text-fg"
      >
        <h2 id={headingId} className="text-base font-semibold">{text("tripStart.heading")}</h2>
        <p className="mt-2 text-sm text-fg-secondary">{text("tripStart.intro")}</p>
        <ul className="mt-2 ml-5 list-disc text-sm text-fg-secondary flex flex-col gap-1">
          {prompts.location && <li data-testid="trip-start-location">{text("tripStart.location")}</li>}
          {prompts.notifications && (
            <li data-testid="trip-start-notifications">{text("tripStart.notifications")}</li>
          )}
        </ul>
        <p className="mt-2 text-sm text-fg-secondary">{text("tripStart.optional")}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 px-4 rounded-lg border border-divider text-sm"
          >
            {text("tripStart.cancel")}
          </button>
          <button
            ref={startRef}
            type="button"
            onClick={onStart}
            data-testid="trip-start-confirm"
            className="min-h-11 px-4 rounded-lg bg-primary text-white text-sm font-semibold"
          >
            {text("tripStart.start")}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface TripStart {
  /** The user chose an itinerary: start it, explaining any prompts first. */
  request: (itinerary: Itinerary) => void;
  /** The explanation while it is open, else null. */
  dialog: ReactNode;
}

/**
 * Starting a trip from route results. When starting would make the browser
 * ask for location or notification permission, the explanation comes first
 * and its **Start trip** button (a fresh user action) makes the requests.
 */
export function useTripStart(
  onStarted: () => void,
  pending: () => Promise<TripStartPrompts> = pendingTripStartPrompts,
): TripStart {
  const [open, setOpen] = useState<{ itinerary: Itinerary; prompts: TripStartPrompts } | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const start = useCallback(
    (itinerary: Itinerary) => {
      beginTrip(itinerary);
      onStarted();
    },
    [onStarted],
  );

  const request = useCallback(
    (itinerary: Itinerary) => {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void pending().then((prompts) => {
        if (prompts.location || prompts.notifications) setOpen({ itinerary, prompts });
        else start(itinerary);
      });
    },
    [pending, start],
  );

  const confirm = useCallback(() => {
    if (!open) return;
    setOpen(null);
    start(open.itinerary);
  }, [open, start]);

  const cancel = useCallback(() => {
    setOpen(null);
    openerRef.current?.focus();
  }, []);

  return {
    request,
    dialog: open ? (
      <TripStartExplainer prompts={open.prompts} onStart={confirm} onCancel={cancel} />
    ) : null,
  };
}
