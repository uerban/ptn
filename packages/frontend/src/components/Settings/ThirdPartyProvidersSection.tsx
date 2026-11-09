import {
  GEOCODER_PROVIDERS,
  type ThirdPartyProviderId,
} from "../../config/geocoderProviders.ts";
import { DEFAULT_GRID_METERS } from "../../services/geocoder/ThirdPartyGeocoderAdapter.ts";
import { usePolicy, usePrivacyStore } from "../../stores/privacyStore.ts";
import { isFlowAvailable } from "../../privacy/flowGrants.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useTranslation, usePrivacyNamespace } from "../../i18n/index.ts";

export function ThirdPartyProvidersSection() {
  const { t } = useTranslation();
  // This section renders privacy.* copy, which is fetched on demand rather
  // than shipped in the base locale — see loadPrivacyNamespace in i18n/index.
  usePrivacyNamespace();
  const setOverride = usePrivacyStore((s) => s.setOverride);
  const policy = usePolicy();
  const provider = useSettingsStore((s) => s.thirdPartyProvider);
  const apiKeys = useSettingsStore((s) => s.thirdPartyApiKeys);
  const setProvider = useSettingsStore((s) => s.setThirdPartyProvider);
  const setApiKey = useSettingsStore((s) => s.setThirdPartyApiKey);

  // Configuring a provider sends nothing: requests wait for the provider's
  // own decision. The section is locked only when no provider can run.
  const locked = (Object.keys(GEOCODER_PROVIDERS) as ThirdPartyProviderId[]).every(
    (id) => !isFlowAvailable("external.place-search", id),
  );
  const effectiveGridMeters = policy.m10CoarsenGridDefaultMeters > 0
    ? policy.m10CoarsenGridDefaultMeters
    : DEFAULT_GRID_METERS;

  return (
    <section>
      <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
        {t("settings.thirdPartyProviders", "Third-party providers")}
      </h2>
      {locked ? (
        <div className="bg-surface-raised rounded-xl border border-divider px-4 py-3 opacity-50">
          <p className="text-xs text-fg-muted italic">
            {t(
              "privacy.thirdParty.unavailable",
              "Third-party geocoding is not available in this version of the app.",
            )}
          </p>
        </div>
      ) : (
        <div className="bg-surface-raised rounded-xl border border-divider">
          {(
            Object.keys(GEOCODER_PROVIDERS) as ThirdPartyProviderId[]
          ).map((id) => {
            const cfg = GEOCODER_PROVIDERS[id];
            return (
              <label
                key={id}
                className="flex items-start justify-between gap-3 px-4 py-3 border-b border-divider last:border-b-0 cursor-pointer"
              >
                <span className="flex flex-col gap-1">
                  <span className="text-sm text-fg">{cfg.name}</span>
                  <span className="text-xs text-fg-muted">{cfg.tosUrl}</span>
                  {cfg.apiKeyFormat && (
                    <input
                      type="password"
                      autoComplete="off"
                      data-provider={id}
                      placeholder={t(
                        `settings.thirdParty.${id}.apiKeyPlaceholder`,
                        `${cfg.name} API key`,
                      )}
                      value={apiKeys[id] ?? ""}
                      onChange={(e) => setApiKey(id, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1 px-2 py-1 text-xs rounded border border-divider bg-surface-overlay text-fg"
                    />
                  )}
                </span>
                <input
                  type="radio"
                  name="third-party-provider"
                  value={id}
                  checked={provider === id}
                  onChange={() => setProvider(id)}
                  className="accent-accent mt-1"
                />
              </label>
            );
          })}
          <div className="px-4 py-3 border-t border-divider">
            <label className="flex flex-col gap-2">
              <span className="text-sm text-fg">
                {t("settings.thirdParty.gridSize", "Coordinate grid size")}
              </span>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={policy.m10CoarsenGridFloorMeters}
                  max={5000}
                  step={25}
                  value={effectiveGridMeters}
                  onChange={(e) =>
                    setOverride(
                      "m10CoarsenGridDefaultMeters",
                      Number(e.target.value),
                    )
                  }
                  className="flex-1"
                />
                <span className="text-xs text-fg-muted w-14 text-right">
                  {effectiveGridMeters}m
                </span>
              </div>
            </label>
          </div>
          <div className="px-4 py-3 border-t border-divider" data-testid="third-party-disclosure">
            <p className="text-xs text-fg-muted leading-relaxed">
              {t(
                "privacy.disclosure.thirdParty",
                "Enabling this sends coordinates (grid-snapped to {gridMeters}m) to {provider}. Network address, timing, and browser fingerprint are NOT mitigated. Use Tor Browser or a VPN for that tier.",
              )
                .replace("{gridMeters}", String(effectiveGridMeters))
                .replace("{provider}", GEOCODER_PROVIDERS[provider].name)}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
