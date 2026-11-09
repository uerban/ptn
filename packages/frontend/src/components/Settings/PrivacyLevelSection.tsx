import {
  PRIVACY_LEVELS,
  type PrivacyLevel,
  type ProtectionAxis,
  type ProtectionPolicy,
} from "@pt/shared/privacy";
import { CarriedOverOverrides } from "./CarriedOverOverrides.tsx";
import { NetworkDecisionsSection } from "./NetworkDecisionsSection.tsx";
import { PolicyAxisControl } from "./PolicyAxisControl.tsx";
import { PrivacyStatusSummary } from "./PrivacyStatusSummary.tsx";
import { ThirdPartyProvidersSection } from "./ThirdPartyProvidersSection.tsx";
import { usePrivacyStore } from "../../stores/privacyStore.ts";
import { useTranslation, usePrivacyNamespace } from "../../i18n/index.ts";
import { countRecents, clearRecents } from "../../services/recents.ts";

const LEVEL_FALLBACKS: Record<PrivacyLevel, { name: string; description: string }> = {
  baseline: {
    name: "Baseline",
    description:
      "Least protection. History is kept until you delete it, map taps and shared links keep exact positions, and error reports are kept.",
  },
  standard: {
    name: "Standard",
    description:
      "Recommended. Map taps are snapped to the nearest stop and shared links use rounded positions. The city's place data downloads once instead of as you pan.",
  },
  hardened: {
    name: "Hardened",
    description:
      "History is kept for 30 days. Map taps are rounded to 50 m, shared links leave out coordinates, and error reports are off. Place data requests come with cover requests.",
  },
  strict: {
    name: "Strict",
    description:
      "History is kept for 7 days. Stops are not personalized by how often you use them. Saved places cannot be exported. Shared links leave out coordinates. Place data requests come with cover requests.",
  },
  paranoid: {
    name: "Paranoid",
    description:
      "History stays in memory only. Saved places cannot be exported or shared, and links are not shared. Map taps are not turned into addresses. A cover request is also made every 2–5 minutes while the app is open.",
  },
};

const AXES: {
  axis: ProtectionAxis;
  title: string;
  /** Always-visible one-line summary. */
  description: string;
  /** Key into DISCLOSURES — the full threat-model detail for this knob. */
  disclosure?: string;
}[] = [
  {
    axis: "recentsEncryption",
    title: "Recent locations",
    description: "How recent origin and destination entries are stored on this device.",
    disclosure: "installKey",
  },
  {
    axis: "savesEncryption",
    title: "Saved places",
    description:
      "How saved places (home, work, favourites) are stored and what can be done with them.",
  },
  {
    axis: "mapTapPersistedPrecision",
    title: "Map tap precision",
    description: "How precisely a tapped location is recorded when stored in recents.",
    disclosure: "mapTap",
  },
  {
    axis: "urlShare",
    title: "URL share & deep links",
    description: "What coordinate data may appear in shareable URLs.",
    disclosure: "urlShare",
  },
  {
    axis: "providerFallback",
    title: "Provider fallback",
    description: "What happens when a geocoder provider fails.",
    disclosure: "providerFallback",
  },
  {
    axis: "errorReporting",
    title: "Error reporting",
    description: "Allow the app to buffer error reports for later delivery.",
    disclosure: "errorReporting",
  },
];

// Threat-model disclosure copy, keyed by disclosure id. Each one is
// rendered under the axis control it describes (see AXES.disclosure);
// `atRest` is level-wide and renders as intro copy instead.
const DISCLOSURES: Record<string, string> = {
  atRest:
    "Recent locations, saved places, and preferences can be stored in this browser according to your settings. PTN also requests public transit data from its operator; enabled map, search, and routing providers receive only the fields listed in their disclosures.",
  installKey:
    "Saved places, recents and favorites are encrypted on this device with a per-install key kept in this browser. Clearing site data destroys the key and makes them unreadable.",
  mapTap:
    "When you tap the map to set an origin or destination, the coordinate saved into recents is snapped or rounded according to your privacy preset. Exact taps are never persisted at Hardened or above.",
  urlShare:
    "Shareable URLs can carry coordinates, stop IDs, or nothing at all. At Hardened and above, coordinates are stripped and the URL references stop IDs only.",
  providerFallback:
    "Geocoder providers are tried in order of privacy tier (local, then self-hosted, then third-party). Fallbacks never happen silently at Standard or above — a status indicator shows which provider answered.",
  errorReporting:
    "If enabled, internal error reports are buffered locally for possible later delivery to help fix bugs. At Hardened and above, error reporting is disabled and the buffer is never written.",
  m10DedupCache:
    "Dedup cache reduces third-party calls but creates a write-once query log on device. The log is unconditionally encrypted via the install key and expires per your privacy level (30d Baseline, 7d Standard, 1d Hardened when third-party is re-enabled). Strict and Paranoid do not cache. Browser profile reset destroys it with the install key.",
  m11Tiles:
    "Panning the map fetches area-of-interest tiles from the PTN backend. Each tile names a ~12 km grid cell and is guaranteed to contain at least 50 places (build-time check). Single tiles reveal a coarse area; a long sequence of tiles from the same IP reveals pan patterns at that granularity. Your privacy preset picks a defense: Baseline loads on demand (no extra traffic); Standard prefetches the whole city once (~70–110 kB per city, zero runtime requests after that); Hardened adds 2 decoy tiles alongside each real fetch; Strict does the same; Paranoid also fires a decoy tile every 2–5 minutes while the app is visible. None of these defenses fully defeat an operator who logs tile requests over time — use Tor or a VPN if you need network-layer unlinkability.",
};

export function PrivacyLevelSection() {
  const { t } = useTranslation();
  // This section renders privacy.* copy, which is fetched on demand rather
  // than shipped in the base locale — see loadPrivacyNamespace in i18n/index.
  usePrivacyNamespace();
  const level = usePrivacyStore((s) => s.level);
  const setLevel = usePrivacyStore((s) => s.setLevel);

  // Intercept changes to the recentsEncryption axis: when the user selects
  // "off", confirm they want to purge any existing recents and then clear
  // them before applying the override.
  //
  // Limitation: this gate fires only via this Settings UI interceptChange.
  // A programmatic `setOverride("recentsEncryption", "off")` would not
  // trigger the purge — no such caller exists today.
  const recentsInterceptChange = async (
    next: ProtectionPolicy["recentsEncryption"],
  ): Promise<boolean> => {
    if (next !== "off") return true;
    const n = await countRecents();
    if (n > 0) {
      const msg = t(
        "settings.recents_off_confirm",
        "Turn off recents and delete {count} stored recent location(s)? This cannot be undone.",
      ).replace("{count}", String(n));
      if (!window.confirm(msg)) return false;
    }
    await clearRecents();
    return true;
  };

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
          {t("settings.privacy", "Privacy")}
        </h2>
        <p className="text-xs text-fg-secondary mb-2">
          {t("privacy.disclosure.atRest", DISCLOSURES.atRest)}
        </p>
        <PrivacyStatusSummary />
        <h3 id="privacy-level-heading" className="text-sm font-semibold text-fg mt-4 mb-1">
          {t("privacy.level.title", "Protection level")}
        </h3>
        <p id="privacy-level-scope" className="text-xs text-fg-secondary mb-2">
          {t(
            "privacy.level.scope",
            "The level sets what is kept on this device and how precisely. Online services are chosen separately below.",
          )}
        </p>
        <div
          role="radiogroup"
          aria-labelledby="privacy-level-heading"
          aria-describedby="privacy-level-scope"
          className="bg-surface-raised rounded-xl border border-divider"
        >
          {PRIVACY_LEVELS.map((lvl) => (
            <label
              key={lvl}
              className="flex items-start justify-between gap-3 px-4 py-3 min-h-11 border-b border-divider last:border-b-0 cursor-pointer"
            >
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm text-fg">
                  {t(`privacy.level.${lvl}.name`, LEVEL_FALLBACKS[lvl].name)}
                </span>
                <span className="text-xs text-fg-muted">
                  {t(
                    `privacy.level.${lvl}.description`,
                    LEVEL_FALLBACKS[lvl].description,
                  )}
                </span>
              </span>
              <input
                type="radio"
                name="privacy-level"
                value={lvl}
                checked={level === lvl}
                onChange={() => {
                  void setLevel(lvl, {
                    confirm: (msg) =>
                      typeof window !== "undefined" && window.confirm
                        ? window.confirm(msg)
                        : true,
                    downgradeMessage: t(
                      "privacy.level.downgradeWarning",
                      "Lowering your privacy level can re-expose previously protected data on this device. Continue?",
                    ),
                  });
                }}
                className="accent-accent mt-1"
              />
            </label>
          ))}
        </div>
        <details className="mt-2">
          <summary className="text-xs text-fg-muted cursor-pointer select-none">
            {t("privacy.tileDefense.detailSummary", "Place data requests in full detail")}
          </summary>
          <p className="text-xs text-fg-secondary mt-1">
            {t("privacy.disclosure.m11Tiles", DISCLOSURES.m11Tiles)}
          </p>
        </details>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider">
          {t("settings.privacy_overrides", "Per-axis overrides")}
        </h2>
        {AXES.map(({ axis, title, description, disclosure }) => (
          <div key={String(axis)} data-axis-group={String(axis)}>
            <h3 className="text-sm font-semibold text-fg mb-1">
              {t(`privacy.axis.${String(axis)}.title`, title)}
            </h3>
            <p className="text-xs text-fg-muted mb-2">
              {t(`privacy.axis.${String(axis)}.description`, description)}
            </p>
            <PolicyAxisControl
              axis={axis}
              i18nKeyPrefix={`privacy.axis.${String(axis)}`}
              interceptChange={axis === "recentsEncryption" ? (recentsInterceptChange as never) : undefined}
            />
            {disclosure && (
              <details className="mt-2">
                <summary className="text-xs text-fg-muted cursor-pointer select-none">
                  {t("settings.privacy_full_detail", "Full detail")}
                </summary>
                <p className="text-xs text-fg-secondary mt-1">
                  {t(`privacy.disclosure.${disclosure}`, DISCLOSURES[disclosure])}
                </p>
              </details>
            )}
          </div>
        ))}
      </section>

      <NetworkDecisionsSection
        details={{
          "external.place-search": t(
            "privacy.disclosure.m10DedupCache",
            DISCLOSURES.m10DedupCache,
          ),
        }}
      />

      <CarriedOverOverrides />

      <ThirdPartyProvidersSection />
    </div>
  );
}
