import {
  LEVEL_FLOORS,
  matchOnboardingPreset,
  type ProtectionPolicy,
} from "@pt/shared/privacy";
import { usePrivacyNamespace, useTranslation } from "../../i18n/index.ts";
import { findDataFlow } from "../../privacy/dataFlowRegistry.ts";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";
import { usePolicy, usePrivacyStore } from "../../stores/privacyStore.ts";

const STATUS_FALLBACKS = {
  recommended: {
    name: "Recommended",
    description:
      "Standard protection, with live departures and service alerts where the city publishes them.",
  },
  strict: {
    name: "Strict privacy",
    description: "Strict protection. Optional online services stay off until you turn them on.",
  },
  custom: {
    name: "Custom",
    description:
      "You changed the level or a service yourself. Each change applies only to what you changed.",
  },
} as const;

const RETENTION_FALLBACKS: Record<ProtectionPolicy["recentsEncryption"], string> = {
  encrypted: "History is kept on this device until you delete it.",
  "encrypted-30d": "History is kept on this device for 30 days.",
  "encrypted-7d": "History is kept on this device for 7 days.",
  "ram-only": "History stays in memory only and is gone when you close the app.",
  off: "History is not kept.",
};

const TILE_DEFENSE_FALLBACKS: Record<ProtectionPolicy["m11TileDefense"], string> = {
  none: "Place data for the map loads for the area you look at, with no extra requests.",
  prefetch:
    "The city's place data downloads once (about 70–110 kB), so panning the map makes no further requests.",
  "prefetch-padding":
    "The city's place data downloads once, and each further request comes with two cover requests.",
  "prefetch-padding-decoy":
    "The city's place data downloads once, each further request comes with two cover requests, and a cover request is also made every 2–5 minutes while the app is open.",
};

/**
 * The privacy summary at the top of the privacy settings: which setup the
 * current level and decisions amount to (Recommended, Strict privacy or
 * Custom), which optional services are on, what the level keeps and sends,
 * and how to lower it. Everything here is read from the same level and
 * decisions the app enforces; nothing is stored separately.
 */
export function PrivacyStatusSummary() {
  const { t, formattingLocale } = useTranslation();
  // Service names come from the privacy namespace; wait for it rather than
  // painting flow ids.
  const ready = usePrivacyNamespace();
  const level = usePrivacyStore((s) => s.level);
  const policy = usePolicy();
  const decisions = useNetworkDecisionsStore((s) => s.decisions);
  const status = matchOnboardingPreset(level, decisions);

  const servicesOn = Object.entries(decisions)
    .filter(([, decision]) => decision.value === "allowed")
    .map(([key]) => {
      const [flowId] = key.split("@");
      const flow = findDataFlow(flowId);
      return flow ? t(flow.nameKey, flowId) : flowId;
    });
  const uniqueServices = [...new Set(servicesOn)];
  let servicesText: string;
  if (uniqueServices.length === 0) {
    servicesText = t("privacy.status.noServices", "No optional online services are on.");
  } else {
    let list: string;
    try {
      list = new Intl.ListFormat(formattingLocale, { style: "long", type: "conjunction" }).format(
        uniqueServices,
      );
    } catch {
      list = uniqueServices.join(", ");
    }
    servicesText = t("privacy.status.servicesOn", "On: {services}.").replace("{services}", list);
  }

  if (!ready) return null;
  const lowestLevel = level === "baseline";
  const tileDefense = policy.m11TileDefense;
  const levelTileDefense = LEVEL_FLOORS[level].m11TileDefense;

  return (
    <div
      data-testid="privacy-status"
      role="group"
      aria-labelledby="privacy-status-heading"
      className="bg-surface-raised rounded-xl border border-divider px-4 py-3 space-y-2"
    >
      <h3 id="privacy-status-heading" className="text-sm font-semibold text-fg">
        {t("privacy.status.title", "Current setup")}
        {": "}
        <span data-testid="privacy-status-name">
          {t(`privacy.status.${status}.name`, STATUS_FALLBACKS[status].name)}
        </span>
      </h3>
      <p className="text-xs text-fg-secondary">
        {t(`privacy.status.${status}.description`, STATUS_FALLBACKS[status].description)}
      </p>
      <p className="text-xs text-fg-secondary">{servicesText}</p>
      <p className="text-xs text-fg-secondary">
        {t(
          `privacy.retention.${policy.recentsEncryption}`,
          RETENTION_FALLBACKS[policy.recentsEncryption],
        )}{" "}
        {t(
          "privacy.retention.delete",
          "You can delete saved places and history at any time under Delete data.",
        )}
      </p>
      <p className="text-xs text-fg-secondary" data-testid="privacy-tile-defense">
        {t(`privacy.tileDefense.${tileDefense}`, TILE_DEFENSE_FALLBACKS[tileDefense])}
        {tileDefense !== levelTileDefense && (
          <>
            {" "}
            {t(
              "privacy.tileDefense.carriedOver",
              "This is stricter than your level because a carried-over setting is kept.",
            )}
          </>
        )}
      </p>
      {!lowestLevel && (
        <p className="text-xs text-fg-secondary">
          {t(
            "privacy.status.lowerLevel",
            "To lower the protection level, choose a lower level below. You confirm before it changes, and it never turns online services on or off.",
          )}
        </p>
      )}
    </div>
  );
}
