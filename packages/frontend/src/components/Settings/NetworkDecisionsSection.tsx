import type { ReactNode } from "react";
import {
  resolveNetworkDecision,
  type NetworkDecisionValue,
} from "@pt/shared/privacy";
import { getCapability } from "../../privacy/capabilityRegistry.ts";
import { isFlowAvailable } from "../../privacy/flowGrants.ts";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { getDataFlow } from "../../privacy/dataFlowRegistry.ts";
import { DEFAULT_BASEMAP_PROVIDER } from "../../services/basemapPrivacy.ts";
import { useTranslation } from "../../i18n/index.ts";

interface FlowRow {
  readonly flowId: string;
  readonly providerId?: string;
  /** Full-detail disclosure rendered under the row. */
  readonly detail?: ReactNode;
}

const OPTIONS: readonly { value: NetworkDecisionValue; key: string; fallback: string }[] = [
  { value: "allowed", key: "privacy.decision.allowed", fallback: "On" },
  { value: "unset", key: "privacy.decision.unset", fallback: "Ask first" },
  { value: "denied", key: "privacy.decision.denied", fallback: "Off" },
];

/**
 * One control per optional network flow. Each row writes exactly its own
 * decision (source `settings`): it never changes the protection level, another
 * flow, or a presentation setting. Flows whose hard constraints fail (no
 * provider, city without the feed, ...) are not listed. Nearby-stop lookup is
 * local and is not offered as a network service.
 */
export function NetworkDecisionsSection({
  details = {},
}: {
  /** Disclosures keyed by flow id. */
  details?: Readonly<Record<string, ReactNode>>;
}) {
  const { t } = useTranslation();
  const decisions = useNetworkDecisionsStore((s) => s.decisions);
  const setDecision = useNetworkDecisionsStore((s) => s.setDecision);
  const placeSearchProvider = useSettingsStore((s) => s.thirdPartyProvider);
  // Bike share is not a stored decision: its map button asks on each visit.
  const cityHasBikeShare = useCityStore((s) => !!s.activeCity.sharedMobility?.length);
  const bikeShare = cityHasBikeShare ? getDataFlow("external.bike-share") : undefined;

  const rows: FlowRow[] = [
    { flowId: "operator.realtime" },
    { flowId: "operator.service-alerts" },
    { flowId: "external.detailed-basemap", providerId: DEFAULT_BASEMAP_PROVIDER },
    { flowId: "operator.place-search" },
    { flowId: "external.place-search", providerId: placeSearchProvider },
    { flowId: "external.stop-search" },
    { flowId: "operator.remote-routing" },
    { flowId: "external.remote-routing", providerId: "transitous" },
    { flowId: "operator.client-report" },
  ].filter((row) => isFlowAvailable(row.flowId, row.providerId));

  return (
    <section aria-labelledby="network-decisions-heading" className="space-y-4">
      <h2
        id="network-decisions-heading"
        className="text-sm font-semibold text-fg-muted uppercase tracking-wider"
      >
        {t("privacy.decisions.title", "Network services")}
      </h2>
      <p className="text-xs text-fg-secondary">
        {t(
          "privacy.decisions.description",
          "Each optional service connects only while it is on. Changing one never changes your privacy level or the other services.",
        )}
      </p>
      {rows.map(({ flowId, providerId }) => {
        const flow = getCapability(flowId)?.dataFlow;
        const name = flow ? t(flow.nameKey, flowId) : flowId;
        const groupId = providerId ? `${flowId}@${providerId}` : flowId;
        const current = resolveNetworkDecision(decisions, flowId, providerId).value;
        const detail = details[flowId];
        return (
          <div key={groupId} data-flow-group={groupId}>
            <h3 className="text-sm font-semibold text-fg mb-1">
              {providerId && flowId.startsWith("external.") ? `${name} · ${providerId}` : name}
            </h3>
            {flow && (
              <p className="text-xs text-fg-muted mb-2">{t(flow.purposeKey, "")}</p>
            )}
            <div
              role="radiogroup"
              aria-label={name}
              className="bg-surface-raised rounded-xl border border-divider"
            >
              {OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex items-center justify-between gap-3 px-4 py-3 border-b border-divider last:border-b-0 cursor-pointer"
                >
                  <span className="text-sm text-fg">{t(option.key, option.fallback)}</span>
                  <input
                    type="radio"
                    name={`network-decision-${groupId}`}
                    value={option.value}
                    checked={current === option.value}
                    onChange={() => setDecision(flowId, option.value, "settings", providerId)}
                    className="accent-accent"
                  />
                </label>
              ))}
            </div>
            {detail && (
              <details className="mt-2">
                <summary className="text-xs text-fg-muted cursor-pointer select-none">
                  {t("settings.privacy_full_detail", "Full detail")}
                </summary>
                <p className="text-xs text-fg-secondary mt-1">{detail}</p>
              </details>
            )}
          </div>
        );
      })}
      {bikeShare && (
        <div data-flow-group="external.bike-share">
          <h3 className="text-sm font-semibold text-fg mb-1">
            {t(bikeShare.nameKey, "Bike share")}
          </h3>
          <p className="text-xs text-fg-muted">{t(bikeShare.purposeKey, "")}</p>
          <p className="mt-1 text-xs text-fg-secondary">
            {t(
              "privacy.decisions.perVisit",
              "Turned on for one visit at a time with the Bikes button on the map; never on when the app starts.",
            )}
          </p>
        </div>
      )}
    </section>
  );
}
