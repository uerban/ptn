import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import { useCanUse } from "../../privacy/canUse.ts";
import { SERVICE_ALERTS_FLOW_ID } from "../../services/serviceAlertsClient.ts";
import {
  answerAlertsOffer,
  noteAlertsOfferSkipped,
  useAlertsOfferOpen,
} from "../../services/serviceAlertsOffer.ts";
import { unseenWhatsNewEntries, type WhatsNewEntry } from "../../services/whatsNew.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";
import { useOnboardingStore } from "../../stores/onboardingStore.ts";
import { Icon } from "../Icon.tsx";

export interface WhatsNewCardProps {
  /** `overlay` floats over the map; `inline` sits in the page flow (Text mode). */
  placement: "overlay" | "inline";
}

/**
 * What's new after an update, on the home screen only. Lists every entry
 * the user has not seen (skipped releases combine into one card). Not modal,
 * takes no focus and is not a live region; closes with its close button or
 * Escape, which stores the highest id shown. Hidden during trip guidance,
 * and in every tab once any tab closes it (the record syncs across tabs).
 *
 * The service-alerts item carries the alerts offer (**Turn on** · **Not
 * now**) when the offer is open for the city. Closing the card without
 * answering counts as **Not now**.
 */
export function WhatsNewCard({ placement }: WhatsNewCardProps) {
  const record = useOnboardingStore((s) => s.record);
  const guiding = useGuidanceStore((s) => s.phase !== "idle");
  const entries = useMemo(() => unseenWhatsNewEntries(record), [record]);
  if (entries.length === 0 || guiding) return null;
  return <WhatsNewCardBody entries={entries} placement={placement} />;
}

function WhatsNewCardBody({
  entries,
  placement,
}: {
  entries: readonly WhatsNewEntry[];
  placement: WhatsNewCardProps["placement"];
}) {
  const text = usePresentationText();
  const headingId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const cityId = useCityStore((s) => s.activeCity.id);
  const cityName = useCityStore((s) => s.activeCity.name);
  const offerOpen = useAlertsOfferOpen(cityId);
  const alertsOn = useCanUse(SERVICE_ALERTS_FLOW_ID);
  const [answer, setAnswer] = useState<"allowed" | "not-now" | null>(null);
  const hasAlertsItem = entries.some((entry) => entry.topic === "service-alerts");
  const asking = hasAlertsItem && offerOpen && answer === null;

  const close = () => {
    const highest = entries.reduce((max, entry) => Math.max(max, entry.id), 0);
    useOnboardingStore.getState().markWhatsNewSeen(highest, { alertsNotNow: asking });
    if (asking) noteAlertsOfferSkipped();
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Only when nothing else has focus, or focus is in the card: Escape
      // in a sheet or dialog belongs to that surface.
      const active = document.activeElement;
      const idle = !active || active === document.body;
      if (!idle && !cardRef.current?.contains(active)) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const answerOffer = (value: "allowed" | "not-now") => {
    answerAlertsOffer(value);
    setAnswer(value);
  };

  return (
    <section
      ref={cardRef}
      aria-labelledby={headingId}
      data-testid="whats-new"
      className={
        placement === "overlay"
          ? "pointer-events-auto mx-3 mt-2 sm:ml-auto sm:w-96 rounded-xl bg-surface-raised shadow-2 border border-divider p-3 text-fg"
          : "mx-3 mt-3 rounded-xl bg-surface-raised shadow-1 border border-divider p-3 text-fg"
      }
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          {text("whatsNew.heading")}
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label={text("whatsNew.close")}
          data-testid="whats-new-close"
          className="-mt-1 -mr-1 p-2 rounded-full hover:bg-surface-overlay"
        >
          <Icon name="close" className="text-fg-muted" />
        </button>
      </div>
      <ul className="list-none m-0 p-0 mt-1 flex flex-col gap-3">
        {entries.map((entry) =>
          entry.topic === "service-alerts" ? (
            <li key={entry.id} data-testid="whats-new-entry" data-topic={entry.topic}>
              <h3 className="text-sm font-semibold">{text("whatsNew.serviceAlerts.title")}</h3>
              <p className="text-sm text-fg-secondary mt-0.5">
                {text("whatsNew.serviceAlerts.body")}
              </p>
              {asking ? (
                <div className="mt-2 flex flex-col gap-2">
                  <p className="text-xs text-fg-muted">
                    {text("serviceAlerts.offerDetails", {
                      city: cityName || text("serviceAlerts.offerCityFallback"),
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => answerOffer("allowed")}
                      className="min-h-11 px-4 rounded-lg bg-primary text-white text-sm font-semibold"
                    >
                      {text("serviceAlerts.turnOn")}
                    </button>
                    <button
                      type="button"
                      onClick={() => answerOffer("not-now")}
                      className="min-h-11 px-4 rounded-lg border border-divider text-sm"
                    >
                      {text("serviceAlerts.notNow")}
                    </button>
                  </div>
                </div>
              ) : alertsOn ? (
                <p className="text-sm text-fg mt-1" data-testid="whats-new-alerts-on">
                  {text("whatsNew.serviceAlerts.on")}
                </p>
              ) : answer === "not-now" ? (
                <p className="text-sm text-fg-muted mt-1">{text("whatsNew.serviceAlerts.later")}</p>
              ) : null}
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}
