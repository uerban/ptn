import { useState, useSyncExternalStore } from "react";
import { resolveNetworkDecision } from "@pt/shared/privacy";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";
import {
  applyMapMode,
  isDetailedMapLocked,
  useEffectiveMapMode,
} from "../../map/mapMode.ts";
import {
  DEFAULT_BASEMAP_PROVIDER,
  DETAILED_BASEMAP_FLOW,
  useDetailedBasemapStatus,
  useExternalBasemapAllowed,
} from "../../services/basemapPrivacy.ts";
import {
  loadMicromap,
  useMicromapState,
} from "../../services/micromapLoader.ts";
import { getBasemapProvider } from "../../config/basemapProviders.ts";
import { grantFlow } from "../../privacy/flowGrants.ts";
import { mayOfferUnprompted } from "../../privacy/contextualPrompts.ts";
import { FlowDisclosure } from "../Privacy/FlowDisclosure.tsx";
import { onStorageKeyChange } from "../../services/crossTab.ts";

/** Asking surface, for the session's **Not now** memory. */
export const MAP_DETAIL_SURFACE = "map-detail";
/** Set once the one-time question has been answered; survives reloads. Public UI state. */
export const MAP_DETAIL_ASKED_KEY = "ptn-map-detail-asked";

function readAsked(): boolean {
  try {
    return globalThis.localStorage?.getItem(MAP_DETAIL_ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribeAsked(listener: () => void): () => void {
  return onStorageKeyChange(MAP_DETAIL_ASKED_KEY, listener);
}

/**
 * One-time **detailed maps** decision plus a short line on the state of the
 * local map.
 *
 * There is no standing toggle. Once setup is done and the decision is still
 * unset, the disclosure naming the provider opens once (**Use detailed maps**
 * / **Not now** / **Don't ask again**). Any answer is remembered across
 * reloads (`MAP_DETAIL_ASKED_KEY`), so it is never asked again; the choice
 * stays changeable in Settings. Nothing is requested from the provider before
 * **Use detailed maps**.
 */
export function MapDetailControl() {
  const text = usePresentationText();
  const effectiveMode = useEffectiveMapMode();
  const setMapDetailMode = useSettingsStore((s) => s.setMapDetailMode);
  const cityId = useCityStore((s) => s.activeCity.id);
  const allowed = useExternalBasemapAllowed();
  const decision = useNetworkDecisionsStore(
    (s) =>
      resolveNetworkDecision(s.decisions, DETAILED_BASEMAP_FLOW, DEFAULT_BASEMAP_PROVIDER)
        .value,
  );
  const micromap = useMicromapState(cityId);
  const detailed = useDetailedBasemapStatus();
  const storedAsked = useSyncExternalStore(subscribeAsked, readAsked, readAsked);
  const [answeredNow, setAnsweredNow] = useState(false);

  const locked = isDetailedMapLocked();
  const providerName =
    getBasemapProvider(DEFAULT_BASEMAP_PROVIDER)?.name ?? DEFAULT_BASEMAP_PROVIDER;

  const asking =
    !locked &&
    !answeredNow &&
    !storedAsked &&
    !allowed &&
    decision === "unset" &&
    mayOfferUnprompted(DETAILED_BASEMAP_FLOW, MAP_DETAIL_SURFACE, DEFAULT_BASEMAP_PROVIDER);

  let status: { message: string; title?: string; retry?: boolean } | null = null;
  if (effectiveMode === "micromap") {
    if (micromap === "loading") status = { message: text("mapStatus.loadingMinimal") };
    else if (micromap === "absent")
      status = { message: text("mapStatus.routesOnly"), title: text("mapStatus.absent") };
    else if (micromap === "failed")
      status = { message: text("mapStatus.routesOnly"), title: text("mapStatus.failed"), retry: true };
    else if (micromap === "offline")
      status = { message: text("mapStatus.routesOnly"), title: text("mapStatus.offline"), retry: true };
  } else if (effectiveMode === "detailed") {
    if (detailed === "loading") status = { message: text("mapStatus.loadingDetailed") };
    else if (detailed === "failed") status = { message: text("mapStatus.detailedFailed") };
  }

  return (
    <div
      className="flex flex-col items-start gap-1 max-w-[16rem]"
      data-testid="map-detail-control"
      data-micromap-state={micromap ?? "idle"}
      data-detailed-state={detailed}
    >
      {status && (
        <div
          data-testid="map-status"
          className="rounded-lg bg-surface-raised/95 shadow-1 px-2 py-1 text-xs text-fg-secondary"
        >
          <span className="font-medium text-fg">{status.message}</span>
          {status.title && <span className="block">{status.title}</span>}
          {status.retry && (
            <button
              type="button"
              onClick={() => void loadMicromap(cityId)}
              className="mt-0.5 block min-h-6 text-accent font-medium"
            >
              {text("mapStatus.retry")}
            </button>
          )}
        </div>
      )}
      {asking && (
        <FlowDisclosure
          flowId={DETAILED_BASEMAP_FLOW}
          providerId={DEFAULT_BASEMAP_PROVIDER}
          surface={MAP_DETAIL_SURFACE}
          heading={text("mapDetail.heading")}
          allowLabel={text("mapDetail.allow")}
          recipientName={providerName}
          details={<p>{text("mapDetail.details", { provider: providerName })}</p>}
          onClose={(answer) => {
            setAnsweredNow(true);
            try {
              globalThis.localStorage?.setItem(MAP_DETAIL_ASKED_KEY, "1");
            } catch {
              // Storage unavailable: not asked again for this page only.
            }
            if (answer === "allowed") {
              applyMapMode("detailed", {
                setMapDetailMode,
                grantDetailedMap: (providerId) =>
                  grantFlow(DETAILED_BASEMAP_FLOW, "contextual", providerId),
              });
            }
          }}
        />
      )}
    </div>
  );
}
