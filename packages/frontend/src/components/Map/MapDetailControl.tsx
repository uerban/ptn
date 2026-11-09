import { useRef, useState, useSyncExternalStore } from "react";
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
/** Set once the tip is dismissed; survives reloads. Public UI state. */
export const MAP_DETAIL_HINT_KEY = "ptn-map-detail-hint";

function readHintDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(MAP_DETAIL_HINT_KEY) === "dismissed";
  } catch {
    return false;
  }
}

function subscribeHint(listener: () => void): () => void {
  return onStorageKeyChange(MAP_DETAIL_HINT_KEY, listener);
}

/**
 * **More map detail**, available at once in map mode, plus a short line on
 * the state of the local map.
 *
 * Pressing it is the deliberate action: with detailed maps already allowed
 * it switches to them, otherwise it opens the disclosure naming the provider
 * (**Use detailed maps** / **Not now** / **Don't ask again**). Nothing is
 * requested from the provider before **Use detailed maps**. Pressed again,
 * it returns to the minimal map without revoking the decision.
 *
 * A one-time tip may sit next to it while the decision is unset. It never
 * takes focus and is not announced; dismissing it is remembered across
 * reloads, and **Not now** hides it for the session. City changes and
 * journeys never bring either back.
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
  const storedDismissal = useSyncExternalStore(subscribeHint, readHintDismissed, readHintDismissed);
  const [hintClosed, setHintClosed] = useState(false);
  const [asking, setAsking] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const locked = isDetailedMapLocked();
  const pressed = effectiveMode === "detailed";
  const providerName =
    getBasemapProvider(DEFAULT_BASEMAP_PROVIDER)?.name ?? DEFAULT_BASEMAP_PROVIDER;

  const dismissHint = () => {
    setHintClosed(true);
    try {
      globalThis.localStorage?.setItem(MAP_DETAIL_HINT_KEY, "dismissed");
    } catch {
      // Storage unavailable: the tip stays closed for this page only.
    }
  };

  const onPress = () => {
    if (pressed) {
      setMapDetailMode("micromap");
      return;
    }
    if (allowed) {
      setMapDetailMode("detailed");
      return;
    }
    dismissHint();
    setAsking(true);
  };

  const showHint =
    !locked &&
    !pressed &&
    !asking &&
    !hintClosed &&
    !storedDismissal &&
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
      {!locked && (
        <div className="flex items-center gap-1.5">
          <button
            ref={buttonRef}
            type="button"
            onClick={onPress}
            aria-pressed={pressed}
            data-testid="more-map-detail"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-raised rounded-full shadow-1
              text-xs font-medium shrink-0"
          >
            <span className={pressed ? "text-fg" : "text-fg-muted"}>{text("mapDetail.more")}</span>
          </button>
          {showHint && (
            <span
              data-testid="map-detail-hint"
              className="flex items-center gap-1 rounded-lg bg-surface-raised/95 shadow-1 px-2 py-1 text-xs text-fg-secondary"
            >
              <span>{text("mapDetail.hint")}</span>
              <button
                type="button"
                onClick={dismissHint}
                aria-label={text("mapDetail.hintDismiss")}
                data-testid="map-detail-hint-dismiss"
                className="inline-flex min-h-6 min-w-6 items-center justify-center text-fg-muted"
              >
                ×
              </button>
            </span>
          )}
        </div>
      )}
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
            setAsking(false);
            if (answer === "allowed") {
              applyMapMode("detailed", {
                setMapDetailMode,
                grantDetailedMap: (providerId) =>
                  grantFlow(DETAILED_BASEMAP_FLOW, "contextual", providerId),
              });
            }
            buttonRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
