import { useEffect, useRef, useState } from "react";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import { useCanUse } from "../../privacy/canUse.ts";
import { isFlowAvailable } from "../../privacy/flowGrants.ts";
import { hasServerSideGeocoder } from "../../services/geocoder/registerSelfHosted.ts";
import { FlowDisclosure } from "../Privacy/FlowDisclosure.tsx";

export const PLACE_SEARCH_FLOW = "operator.place-search";

/** Asking surface, for the session's **Not now** memory. */
export const PLACE_SEARCH_SURFACE = "search-suggestions";

export interface ServerPlaceSearchOfferProps {
  cityId: string;
  /** What the user is typing; nothing is offered for an empty field. */
  query: string;
}

/**
 * **Search addresses on the server**: the deliberate action for the
 * operator's address search, shown while the user types a place, the city has
 * an address search server and the flow is not allowed. It opens the
 * contextual prompt (Allow / Not now / Don't ask again); after **Don't ask
 * again** the button stays and the prompt still offers Allow. Granting names
 * this one flow only; the suggestion list reruns on its own once it is
 * allowed.
 */
export function ServerPlaceSearchOffer({ cityId, query }: ServerPlaceSearchOfferProps) {
  const text = usePresentationText();
  const allowed = useCanUse(PLACE_SEARCH_FLOW);
  const [asking, setAsking] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  useEffect(() => {
    if (asking || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    buttonRef.current?.focus();
  }, [asking]);

  if (allowed || !query.trim()) return null;
  if (!isFlowAvailable(PLACE_SEARCH_FLOW) || !hasServerSideGeocoder(cityId)) return null;

  return (
    <div data-testid="server-place-search-offer">
      {!asking && (
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setAsking(true)}
          className="w-full min-h-11 px-4 py-2 text-left text-sm font-medium text-accent
            hover:bg-surface-overlay focus:bg-surface-overlay focus:outline-none"
        >
          {text("placeSearch.show")}
        </button>
      )}
      {asking && (
        <FlowDisclosure
          flowId={PLACE_SEARCH_FLOW}
          surface={PLACE_SEARCH_SURFACE}
          variant="inline"
          heading={text("placeSearch.heading")}
          allowLabel={text("placeSearch.show")}
          details={<p>{text("placeSearch.details")}</p>}
          onClose={() => {
            restoreFocusRef.current = true;
            setAsking(false);
          }}
        />
      )}
    </div>
  );
}
