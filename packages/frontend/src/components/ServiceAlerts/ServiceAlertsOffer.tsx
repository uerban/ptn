import { useId, useState } from "react";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import { answerAlertsOffer } from "../../services/serviceAlertsOffer.ts";

export interface ServiceAlertsOfferProps {
  /** The city's display name; omitted when unknown. */
  cityName?: string;
}

/**
 * The inline alerts offer: “Service alerts are available for <city>.
 * **Turn on** · **Not now**”, with **Don't show again** behind a secondary
 * menu. Shown by the caller only while `useInlineAlertsOffer` holds. Never
 * modal, never takes focus, never a live region.
 */
export function ServiceAlertsOffer({ cityName }: ServiceAlertsOfferProps) {
  const text = usePresentationText();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const city = cityName ?? "";
  return (
    <div
      data-testid="service-alerts-offer"
      className="flex flex-col gap-1 mx-3 my-2 px-3 py-2 rounded-lg border border-divider bg-surface-overlay text-xs text-fg-secondary"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 min-w-[10rem] text-fg">
          {cityName
            ? text("serviceAlerts.offer", { city })
            : text("serviceAlerts.offerGeneric")}
        </p>
        <button
          type="button"
          onClick={() => answerAlertsOffer("allowed")}
          className="min-h-9 px-3 rounded-lg bg-primary text-white font-semibold"
        >
          {text("serviceAlerts.turnOn")}
        </button>
        <button
          type="button"
          onClick={() => answerAlertsOffer("not-now")}
          className="min-h-9 px-3 rounded-lg border border-divider text-fg font-medium"
        >
          {text("serviceAlerts.notNow")}
        </button>
        <button
          type="button"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          aria-label={text("serviceAlerts.moreOptions")}
          onClick={() => setMenuOpen((v) => !v)}
          className="min-h-9 min-w-9 px-2 rounded-lg text-fg-secondary hover:bg-surface-raised"
        >
          <span aria-hidden>⋯</span>
        </button>
      </div>
      <p className="text-fg-muted">
        {text("serviceAlerts.offerDetails", { city: cityName ?? text("serviceAlerts.offerCityFallback") })}
      </p>
      <div id={menuId} hidden={!menuOpen}>
        <button
          type="button"
          onClick={() => answerAlertsOffer("denied")}
          className="min-h-9 px-3 rounded-lg border border-divider text-fg"
        >
          {text("serviceAlerts.dontShowAgain")}
        </button>
      </div>
    </div>
  );
}
