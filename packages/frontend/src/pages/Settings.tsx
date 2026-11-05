import { GpsSettings } from "../components/Settings/GpsSettings.tsx";
import { SearchLayoutSettings } from "../components/Search/SearchLayoutSettings.tsx";
import { useState, useRef, useEffect, Suspense, lazy } from "react";
import {
  useSettingsStore,
  PROFILE_DEFAULT_BUFFER_SECS,
  ROUTING_MODES,
  REMOTE_ROUTING_PROVIDERS,
  type RouteSearchVariant,
  type EtaCardsLayout,
  type SearchProvider,
  type RoutingMode,
  type RemoteRoutingProvider,
} from "../stores/settingsStore.ts";
import { usePolicy } from "../stores/privacyStore.ts";
import { isRemoteRoutingAllowed } from "../services/routingSource.ts";
import { useRemoteRoutingAvailable } from "../services/remoteRoutingAvailability.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { requestNotificationPermission } from "../services/tripNotifications.ts";
import { useTranslation } from "../i18n/index.ts";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { LanguagePicker } from "../components/Settings/LanguagePicker.tsx";
import { MapModeSection } from "../components/Settings/MapModeSection.tsx";
import { ProjectLinks } from "../components/Settings/ProjectLinks.tsx";
import { TransitAttribution } from "../components/Settings/TransitAttribution.tsx";
import { isTransitousAllowed } from "../services/transitousAvailability.ts";
import { getRoutingProvider } from "../config/routingProviders.ts";
import {
  HUYLO_FLASH_LABEL,
  HUYLO_FLASH_MS,
  HUYLO_REVEAL_THRESHOLD,
  nextOverthrowLine,
  type OverthrowLine,
} from "../components/Settings/overthrow.ts";

const AdvancedSettings = lazy(() =>
  import("../components/Settings/AdvancedSettings.tsx").then((m) => ({
    default: m.AdvancedSettings,
  }))
);

const ColorSettings = lazy(() =>
  import("../components/Settings/ColorSettings.tsx").then((m) => ({
    default: m.ColorSettings,
  }))
);

const OfflinePrepSection = lazy(() =>
  import("../components/Settings/OfflinePrepSection.tsx").then((m) => ({
    default: m.OfflinePrepSection,
  }))
);

const PrivacyLevelSection = lazy(() =>
  import("../components/Settings/PrivacyLevelSection.tsx").then((m) => ({
    default: m.PrivacyLevelSection,
  }))
);

const RecentsPurgeControl = lazy(() =>
  import("../components/Settings/RecentsPurgeControl.tsx").then((m) => ({
    default: m.RecentsPurgeControl,
  }))
);

const PrivacyStorageSettings = lazy(() =>
  import("../components/Privacy/PrivacyStorageSettings.tsx").then((m) => ({
    default: m.PrivacyStorageSettings,
  }))
);

const DataDeletionControls = lazy(() =>
  import("../components/Privacy/DataDeletionControls.tsx").then((m) => ({
    default: m.DataDeletionControls,
  }))
);

const PoiAttribution = lazy(() =>
  import("../components/Settings/PoiAttribution.tsx").then((m) => ({
    default: m.PoiAttribution,
  }))
);

const VersionBlock = lazy(() =>
  import("../components/Settings/VersionBlock.tsx").then((m) => ({
    default: m.VersionBlock,
  }))
);

const ForceUpdateButton = lazy(() =>
  import("../components/Settings/ForceUpdateButton.tsx").then((m) => ({
    default: m.ForceUpdateButton,
  }))
);

// Routing-source mode copy. Hoisted to module scope so it isn't rebuilt on every
// ROUTING_MODES.map iteration. The Record<RoutingMode, …> key type keeps it
// compile-time exhaustive over ROUTING_MODES.
const ROUTING_MODE_COPY: Record<RoutingMode, { label: [string, string]; desc: [string, string] }> = {
  "on-device": {
    label: ["settings.routing_source_on_device", "On this device only"],
    desc: ["settings.routing_source_on_device_desc", "Routes are computed on your device. Nothing about your trip leaves it."],
  },
  "provider-fallback": {
    label: ["settings.routing_source_fallback", "On-device, with server fallback"],
    desc: ["settings.routing_source_fallback_desc", "If on-device routing can't find a trip, the server is asked automatically. Your trip query leaves your device only then."],
  },
  "remote-primary": {
    label: ["settings.routing_source_remote_primary", "Server first, on-device fallback"],
    desc: ["settings.routing_source_remote_primary_desc", "Routes are computed on the server. If the server can't be reached, your device routes instead. Your trip query leaves your device on every search."],
  },
};

const TRANSITOUS_PROVIDER = getRoutingProvider("transitous");

/** The walking-speed slider works in km/h, one decimal per step; the store
 *  keeps m/s. The range is the store's 0.5–3.0 m/s. */
const WALK_SPEED_KMH_MIN = 1.8;
const WALK_SPEED_KMH_MAX = 10.8;

export function SettingsPage() {
  const { t } = useTranslation();
  const {
    theme, setTheme,
    departuresPerLine, setDeparturesPerLine,
    urbanMode, urbanLookaheadHours, setUrbanLookaheadHours,
    scheduleMode, setScheduleMode,
    mobilityProfile, setMobilityProfile,
    walkSpeedMps, setWalkSpeedMps,
    maxWalkSecs, setMaxWalkSecs,
    runToCatch, setRunToCatch,
    leaveBufferOverrideSeconds, setLeaveBufferOverrideSeconds,
    getOffAlarmEnabled, setGetOffAlarmEnabled,
    etaCardsEnabled, setEtaCardsEnabled,
    etaCardsLayout, setEtaCardsLayout,
    startupLocate, setStartupLocate,
    tripNotificationsEnabled, setTripNotificationsEnabled,
    routeSearchVariant, setRouteSearchVariant,
    searchProvider, setSearchProvider,
    setRoutingMode, setRoutingProvider,
  } = useSettingsStore();
  const routingMode = useSettingsStore((s) => s.routingMode);
  const routingProvider = useSettingsStore((s) => s.routingProvider);
  // Rounded to the slider's 0.1 km/h step, so the thumb, the label and the
  // screen-reader value agree (wheelchair 0.8 m/s reads 2.9 km/h).
  const walkSpeedKmh = Math.round(walkSpeedMps * 36) / 10;
  const privacyPolicy = usePolicy();
  const remoteForbidden = !isRemoteRoutingAllowed(privacyPolicy);
  const transitousForbidden = !isTransitousAllowed(privacyPolicy);
  // Availability of the remote routing source — a cached,
  // fail-closed up/down hint. Distinct from `remoteForbidden`: a mode can be
  // ALLOWED (user-choice) yet currently DOWN, in which case it stays selectable
  // but is flagged "currently unavailable".
  const cityId = useCityStore((s) => s.activeCity.id);
  const remoteRoutingAvailable = useRemoteRoutingAvailable(cityId);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [versionClicks, setVersionClicks] = useState(0);
  const [overthrow, setOverthrow] = useState<OverthrowLine | null>(null);
  const [huyloActive, setHuyloActive] = useState(false);
  const huyloTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (huyloTimerRef.current !== null) {
        clearTimeout(huyloTimerRef.current);
      }
    };
  }, []);

  const handleVersionClick = () => {
    // One counter drives the whole ladder: click 1 only copies, 2+ flashes
    // HU/LO, 10+ reveals and re-rolls the overthrow line.
    const nextCount = versionClicks + 1;
    setVersionClicks(nextCount);

    if (nextCount >= HUYLO_REVEAL_THRESHOLD) {
      setHuyloActive(true);
      if (huyloTimerRef.current !== null) {
        clearTimeout(huyloTimerRef.current);
      }
      huyloTimerRef.current = setTimeout(() => {
        setHuyloActive(false);
        huyloTimerRef.current = null;
      }, HUYLO_FLASH_MS);
    }

    setOverthrow((prev) => nextOverthrowLine(nextCount, prev) ?? prev);
  };

  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="max-w-lg mx-auto p-4 space-y-6">
        <h1 className="text-xl font-bold text-fg">
          {t("settings.title", "Settings")}
        </h1>

        <GpsSettings />

        {/* Theme */}
        <section>
          <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
            {t("settings.theme_section", "Theme")}
          </h2>
          <div className="bg-surface-raised rounded-xl border border-divider">
            {(["system", "light", "dark"] as const).map((themeVal) => (
              <label
                key={themeVal}
                className="flex items-center justify-between px-4 py-3
                  border-b border-divider last:border-b-0 cursor-pointer"
              >
                <span className="text-sm text-fg">
                  {t(`theme.${themeVal}`, themeVal)}
                </span>
                <input
                  type="radio"
                  name="theme"
                  value={themeVal}
                  checked={theme === themeVal}
                  onChange={() => setTheme(themeVal)}
                  className="accent-accent"
                />
              </label>
            ))}
          </div>
        </section>

        {/* Color & Accessibility */}
        <ErrorBoundary
          fallback={
            <div className="bg-surface-raised rounded-xl border border-divider p-4 text-sm text-fg-muted">
              {t("settings.color_load_error", "Could not load color settings.")}
            </div>
          }
        >
          <Suspense
            fallback={<div className="h-20 bg-surface-overlay rounded-xl animate-pulse" />}
          >
            <ColorSettings />
          </Suspense>
        </ErrorBoundary>

        <LanguagePicker />

        {/* Search provider */}
        <section aria-labelledby="settings-search-provider-heading">
          <h2
            id="settings-search-provider-heading"
            className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2"
          >
            {t("settings.search_provider", "Search")}
          </h2>
          <div
            role="radiogroup"
            aria-labelledby="settings-search-provider-heading"
            className="bg-surface-raised rounded-xl border border-divider"
          >
            {(["local", "remote"] as const).map((provider) => {
              // "Search online" reaches transitous through the operator proxy, so
              // it passes the same third-party egress gate as remote routing —
              // the proxy hop does not exempt it. Local stays selectable so a
              // user can always withdraw the remote choice, mirroring the
              // routing-provider list below.
              const disabled = provider === "remote" && transitousForbidden;
              return (
              <label
                key={provider}
                className={`flex items-center justify-between gap-3 px-4 py-3
                  border-b border-divider last:border-b-0 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
              >
                <div className="min-w-0">
                  <span className="text-sm text-fg block">
                    {provider === "local"
                      ? t("settings.search_provider_local", "Search this device only")
                      : t("settings.search_provider_remote", "Search online")}
                    {disabled ? (
                      <span className="ml-2 text-xs text-fg-muted italic">
                        {t(
                          "settings.routing_provider_blocked",
                          "Off at your privacy level",
                        )}
                      </span>
                    ) : null}
                  </span>
                  <p className="text-xs text-fg-muted">
                    {provider === "local"
                      ? t(
                          "settings.search_provider_local_desc",
                          "Find stops and places from data downloaded for the city you're viewing. Works offline.",
                        )
                      : t(
                          "settings.search_provider_remote_desc",
                          "Find stops using the online routing service. May include results from other cities.",
                        )}
                  </p>
                </div>
                <input
                  type="radio"
                  name="searchProvider"
                  value={provider}
                  checked={searchProvider === provider}
                  disabled={disabled}
                  onChange={() => setSearchProvider(provider satisfies SearchProvider)}
                  className="accent-accent"
                />
              </label>
              );
            })}
          </div>
        </section>

        <SearchLayoutSettings />

        {/* Routing source */}
        <section id="routing-source" aria-labelledby="settings-routing-source-heading">
          <h2
            id="settings-routing-source-heading"
            className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2"
          >
            {t("settings.routing_source", "Trip routing")}
          </h2>
          <div
            role="radiogroup"
            aria-labelledby="settings-routing-source-heading"
            className="bg-surface-raised rounded-xl border border-divider"
          >
            {ROUTING_MODES.map((mode) => {
              // Both remote modes are gated by the privacy ceiling; only
              // `on-device` is always available.
              const disabled = mode !== "on-device" && remoteForbidden;
              const copy = ROUTING_MODE_COPY[mode];
              return (
                <label
                  key={mode}
                  className={`flex items-center justify-between gap-3 px-4 py-3 border-b border-divider last:border-b-0 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                >
                  <div className="min-w-0">
                    <span className="text-sm text-fg block">
                      {t(copy.label[0], copy.label[1])}
                      {disabled && (
                        <span className="ml-2 text-xs text-fg-muted italic">
                          {t("settings.routing_source_blocked", "Off at your privacy level")}
                        </span>
                      )}
                      {/* Mutually exclusive with the blocked hint: `disabled` ⇒
                          privacy-blocked; allowed-but-down ⇒ currently unavailable.
                          The remote modes stay selectable (a user choice) — this
                          is a hint, not a gate. */}
                      {!disabled && mode !== "on-device" && !remoteRoutingAvailable && (
                        <span className="ml-2 text-xs text-warning italic" data-testid={`routing-mode-${mode}-unavailable`}>
                          {t("settings.routing_source_unavailable", "Server unavailable right now")}
                        </span>
                      )}
                    </span>
                    <p className="text-xs text-fg-muted">{t(copy.desc[0], copy.desc[1])}</p>
                  </div>
                  <input
                    type="radio"
                    name="routingMode"
                    value={mode}
                    data-testid={`routing-mode-${mode}`}
                    checked={routingMode === mode}
                    onChange={() => setRoutingMode(mode satisfies RoutingMode)}
                    disabled={disabled}
                    className="accent-accent"
                  />
                </label>
              );
            })}
          </div>
          <h3 className="text-sm font-semibold text-fg mt-4 mb-2">
            {t("settings.routing_provider", "Remote routing provider")}
          </h3>
          <div
            role="radiogroup"
            aria-label={t(
              "settings.routing_provider",
              "Remote routing provider",
            )}
            className="bg-surface-raised rounded-xl border border-divider"
          >
            {REMOTE_ROUTING_PROVIDERS.map((providerId) => {
              const isTransitous = providerId === "transitous";
              // Operator is always selectable so a user can withdraw the
              // third-party provider even while all remote routing is inert.
              const disabled = isTransitous && transitousForbidden;
              return (
                <label
                  key={providerId}
                  className={`flex items-start justify-between gap-3 px-4 py-3 border-b border-divider last:border-b-0 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                >
                  <span className="flex flex-col gap-1">
                    <span className="text-sm text-fg">
                      {isTransitous
                        ? TRANSITOUS_PROVIDER.name
                        : t("settings.routing_provider_operator", "PTN operator")}
                      {disabled ? (
                        <span className="ml-2 text-xs text-fg-muted italic">
                          {t(
                            "settings.routing_provider_blocked",
                            "Off at your privacy level",
                          )}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs text-fg-muted">
                      {isTransitous
                        ? t(
                            "privacy.disclosure.transitousProvider",
                            "Trip start, destination, and departure time are sent through the PTN operator to transitous. Shared fields: {fields}.",
                          ).replace(
                            "{fields}",
                            TRANSITOUS_PROVIDER.requestFields.join(", "),
                          )
                        : t(
                            "settings.routing_provider_operator_desc",
                            "Trip start, destination, and time are sent to the PTN operator when the routing strategy uses a remote provider.",
                          )}
                    </span>
                    {isTransitous ? (
                      <a
                        href={TRANSITOUS_PROVIDER.tosUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-accent underline w-fit"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {t("transitous.terms", "Terms")}
                      </a>
                    ) : null}
                  </span>
                  <input
                    type="radio"
                    name="routingProvider"
                    value={providerId}
                    data-testid={`routing-provider-${providerId}`}
                    checked={routingProvider === providerId}
                    onChange={() =>
                      setRoutingProvider(
                        providerId satisfies RemoteRoutingProvider,
                      )
                    }
                    disabled={disabled}
                    className="accent-accent mt-1"
                  />
                </label>
              );
            })}
          </div>
        </section>

        {/* Departures per line */}
        <section>
          <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
            {t("settings.departures_per_line", "Departures per line")}
          </h2>
          <div className="bg-surface-raised rounded-xl border border-divider px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-fg">{departuresPerLine}</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDeparturesPerLine(departuresPerLine - 1)}
                disabled={departuresPerLine <= 1}
                className="w-8 h-8 rounded-lg bg-surface-overlay text-fg font-bold disabled:opacity-30"
              >−</button>
              <button
                onClick={() => setDeparturesPerLine(departuresPerLine + 1)}
                disabled={departuresPerLine >= 5}
                className="w-8 h-8 rounded-lg bg-surface-overlay text-fg font-bold disabled:opacity-30"
              >+</button>
            </div>
          </div>
        </section>

        {/* Schedule mode */}
        <section>
          <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
            {t("settings.display", "Display")}
          </h2>
          <div className="bg-surface-raised rounded-xl border border-divider px-4">
            <div className="flex items-center justify-between py-3 border-b border-divider">
              <div>
                <span id="settings-schedule-mode-label" className="text-sm text-fg">{t("settings.schedule_mode", "Schedule-only mode")}</span>
                <p id="settings-schedule-mode-desc" className="text-xs text-fg-muted">{t("settings.schedule_mode_desc", "Text-based view without map — faster on slow connections, works with screen readers")}</p>
              </div>
              <button
                role="switch"
                aria-checked={scheduleMode}
                aria-labelledby="settings-schedule-mode-label"
                aria-describedby="settings-schedule-mode-desc"
                onClick={() => setScheduleMode(!scheduleMode)}
                className={`relative w-11 h-6 rounded-full transition-colors ${scheduleMode ? "bg-accent" : "bg-surface-overlay"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${scheduleMode ? "translate-x-5" : ""}`} />
              </button>
            </div>
            <div className="flex items-center justify-between py-3 border-b border-divider">
              <div>
                <span id="settings-eta-cards-label" className="text-sm text-fg">{t("settings.eta_cards", "Nearby departures cards")}</span>
                <p id="settings-eta-cards-desc" className="text-xs text-fg-muted">{t("settings.eta_cards_desc", "Show the next departures near you on the map, in both directions. Tap one to see its stops.")}</p>
              </div>
              <button
                role="switch"
                aria-checked={etaCardsEnabled}
                aria-labelledby="settings-eta-cards-label"
                aria-describedby="settings-eta-cards-desc"
                onClick={() => setEtaCardsEnabled(!etaCardsEnabled)}
                className={`relative w-11 h-6 rounded-full transition-colors ${etaCardsEnabled ? "bg-accent" : "bg-surface-overlay"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${etaCardsEnabled ? "translate-x-5" : ""}`} />
              </button>
            </div>
            {etaCardsEnabled && (
              <div
                role="radiogroup"
                aria-labelledby="eta-layout-label"
                className="flex items-center justify-between py-3 border-b border-divider"
              >
                <span id="eta-layout-label" className="text-sm text-fg">
                  {t("settings.eta_layout", "Cards layout")}
                </span>
                <div className="flex gap-4">
                  {(
                    [
                      { id: "rows", label: t("settings.eta_layout_rows", "Rows") },
                      { id: "columns", label: t("settings.eta_layout_columns", "Columns") },
                    ] satisfies { id: EtaCardsLayout; label: string }[]
                  ).map((l) => (
                    <label key={l.id} className="flex items-center gap-2 cursor-pointer text-sm text-fg">
                      <input
                        type="radio"
                        name="etaCardsLayout"
                        value={l.id}
                        checked={etaCardsLayout === l.id}
                        onChange={() => setEtaCardsLayout(l.id)}
                        className="accent-accent"
                      />
                      {l.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between py-3">
              <div>
                <span id="settings-startup-locate-label" className="text-sm text-fg">{t("settings.startup_locate", "Center on my location at startup")}</span>
                <p id="settings-startup-locate-desc" className="text-xs text-fg-muted">{t("settings.startup_locate_desc", "Fly to your GPS location when the app opens. Off keeps the map where you left it.")}</p>
              </div>
              <button
                role="switch"
                aria-checked={startupLocate}
                aria-labelledby="settings-startup-locate-label"
                aria-describedby="settings-startup-locate-desc"
                onClick={() => setStartupLocate(!startupLocate)}
                className={`relative w-11 h-6 rounded-full transition-colors ${startupLocate ? "bg-accent" : "bg-surface-overlay"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${startupLocate ? "translate-x-5" : ""}`} />
              </button>
            </div>
          </div>
        </section>

        {/* Map — the single choice for what the canvas draws (map/mapMode.ts) */}
        <MapModeSection />

        {/* Urban mode lookahead */}
        {urbanMode && (
          <section>
            <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
              {t("settings.urban_mode_section", "Urban mode")}
            </h2>
            <div className="bg-surface-raised rounded-xl border border-divider px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-fg">
                  {t("settings.urban_lookahead", "Show lines departing within")}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setUrbanLookaheadHours(urbanLookaheadHours - 1)}
                    disabled={urbanLookaheadHours <= 1}
                    className="w-8 h-8 rounded-full bg-surface-overlay text-fg font-bold disabled:opacity-30"
                  >
                    −
                  </button>
                  <span className="text-sm font-semibold text-fg w-8 text-center">
                    {urbanLookaheadHours}h
                  </span>
                  <button
                    onClick={() => setUrbanLookaheadHours(urbanLookaheadHours + 1)}
                    disabled={urbanLookaheadHours >= 6}
                    className="w-8 h-8 rounded-full bg-surface-overlay text-fg font-bold disabled:opacity-30"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Route-search layout — A/B/C variants */}
        <section id="appearance">
          <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
            {t("settings.appearance", "Appearance")}
          </h2>
          <div className="bg-surface-raised rounded-xl border border-divider px-4 py-3 space-y-3">
            {(
              [
                {
                  id: "consumer",
                  label: t("settings.variant_consumer", "A · Consumer"),
                  desc: t(
                    "settings.variant_consumer_desc",
                    "Clean cards with a time-proportional timeline bar per route.",
                  ),
                },
                {
                  id: "power",
                  label: t("settings.variant_power", "B · Power-user"),
                  desc: t(
                    "settings.variant_power_desc",
                    "Dense timetable-style rows, mono numerics, more routes at once.",
                  ),
                },
                {
                  id: "accessible",
                  label: t("settings.variant_accessible", "C · Accessible"),
                  desc: t(
                    "settings.variant_accessible_desc",
                    "Larger hit targets; each transit leg as its own row with explicit “Off at” copy.",
                  ),
                },
              ] satisfies { id: RouteSearchVariant; label: string; desc: string }[]
            ).map((v) => (
              <label
                key={v.id}
                className="flex items-start gap-3 cursor-pointer"
              >
                <input
                  type="radio"
                  name="routeSearchVariant"
                  value={v.id}
                  checked={routeSearchVariant === v.id}
                  onChange={() => setRouteSearchVariant(v.id)}
                  className="accent-accent mt-1"
                />
                <div>
                  <div className="text-sm text-fg">{v.label}</div>
                  <div className="text-xs text-fg-muted">{v.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </section>

        {/* Routing */}
        <section>
          <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
            {t("settings.routing", "Routing")}
          </h2>
          <div className="bg-surface-raised rounded-xl border border-divider px-4">
            <div className="py-3">
              <span id="settings-mobility-profile-label" className="text-sm text-fg">{t("settings.mobility_profile", "Mobility profile")}</span>
              <div role="group" aria-labelledby="settings-mobility-profile-label" className="flex gap-2 mt-2">
                {(["default", "wheelchair", "vision_impaired", "bicycle"] as const).map((profile) => (
                  <button key={profile} data-testid={`mobility-${profile}`} onClick={() => setMobilityProfile(profile)}
                    aria-pressed={mobilityProfile === profile}
                    className={`px-3 py-1.5 text-xs rounded-lg border ${mobilityProfile === profile ? "border-accent bg-accent/10 text-accent" : "border-divider text-fg-muted"}`}>
                    {profile === "default"
                      ? t("settings.profile_default", "Default")
                      : profile === "wheelchair"
                        ? t("settings.profile_wheelchair", "Wheelchair")
                        : profile === "vision_impaired"
                          ? t("settings.profile_vision", "Vision impaired")
                          : t("settings.profile_bicycle", "Bicycle")}
                  </button>
                ))}
              </div>
            </div>
            <div className="border-t border-divider py-3">
              <div className="flex justify-between">
                <span id="settings-walk-speed-label" className="text-sm text-fg">{t("settings.walk_speed", "Walking speed")}</span>
                <span className="text-sm text-fg-muted">{walkSpeedKmh.toFixed(1)} km/h</span>
              </div>
              {/*
                When the wheelchair profile is active, the slider is locked
                via `aria-disabled` rather than the native `disabled`
                attribute. Native `disabled` removes the input from the
                keyboard tab order, and most screen readers suppress
                `aria-describedby` announcements on disabled form fields,
                so the hint below would never be heard. `aria-disabled=
                "true"` keeps the control focusable so AT users can land
                on it and hear why it doesn't respond.

                The `|| undefined` collapses the attribute to absent when
                the profile is non-wheelchair (cleaner DOM than emitting
                `aria-disabled="false"`). The `onChange` short-circuit is
                separately required because `aria-disabled` is purely
                advisory — the browser still fires change events on
                programmatic / arrow-key value changes, so the handler
                must enforce the lock at the JS layer.
              */}
              <input
                data-testid="walking-speed-slider"
                type="range" min={WALK_SPEED_KMH_MIN} max={WALK_SPEED_KMH_MAX} step={0.1} value={walkSpeedKmh}
                aria-labelledby="settings-walk-speed-label"
                aria-valuetext={`${walkSpeedKmh.toFixed(1)} km/h`}
                aria-disabled={mobilityProfile === "wheelchair" || undefined}
                aria-describedby={mobilityProfile === "wheelchair" ? "walking-speed-wheelchair-hint" : undefined}
                onChange={(e) => {
                  if (mobilityProfile === "wheelchair") return;
                  setWalkSpeedMps(parseFloat(e.target.value) / 3.6);
                }}
                className="w-full mt-1 accent-accent" />
              {mobilityProfile === "wheelchair" && (
                <p
                  data-testid="walking-speed-wheelchair-hint"
                  id="walking-speed-wheelchair-hint"
                  className="text-xs text-fg-muted mt-1"
                >
                  {t(
                    "settings.walk_speed_wheelchair_hint",
                    "Fixed at a comfortable walking pace for the wheelchair profile",
                  )}
                </p>
              )}
            </div>
            <div className="border-t border-divider py-3">
              <div className="flex justify-between">
                <span id="settings-max-walk-label" className="text-sm text-fg">{t("settings.max_walk", "Max walking time")}</span>
                <span className="text-sm text-fg-muted">{Math.round(maxWalkSecs / 60)} min</span>
              </div>
              <input type="range" min={60} max={3600} step={60} value={maxWalkSecs}
                aria-labelledby="settings-max-walk-label"
                aria-valuetext={`${Math.round(maxWalkSecs / 60)} min`}
                onChange={(e) => setMaxWalkSecs(parseInt(e.target.value))} className="w-full mt-1 accent-accent" />
            </div>
            {mobilityProfile === "default" && (
            <div className="flex items-center justify-between border-t border-divider py-3">
              <div>
                <span id="settings-run-to-catch-label" className="text-sm text-fg">{t("settings.run_to_catch", "Run to catch")}</span>
                <p id="settings-run-to-catch-desc" className="text-xs text-fg-muted">{t("settings.run_to_catch_desc", "Reach stops at a running pace to catch departing vehicles")}</p>
              </div>
              <button role="switch" aria-checked={runToCatch} onClick={() => setRunToCatch(!runToCatch)}
                aria-labelledby="settings-run-to-catch-label" aria-describedby="settings-run-to-catch-desc"
                className={`relative w-11 h-6 rounded-full transition-colors ${runToCatch ? "bg-accent" : "bg-surface-overlay"}`}>
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${runToCatch ? "translate-x-5" : ""}`} />
              </button>
            </div>
            )}
            <div className="border-t border-divider py-3">
              <div className="flex items-center justify-between">
                <div className="flex-1 mr-3">
                  <label
                    htmlFor="pre-stop-buffer-default-toggle"
                    className="text-sm text-fg cursor-pointer"
                  >
                    {t("settings.pre_stop_buffer_use_default", "Use profile default")}
                  </label>
                  <p className="text-xs text-fg-muted">
                    {t("settings.pre_stop_buffer_desc", "How early to arrive at the stop")}
                    {leaveBufferOverrideSeconds === null && (
                      <>
                        {" — "}
                        {t(
                          "settings.pre_stop_buffer_resolved",
                          "Using profile default ({n} min)",
                        ).replace(
                          "{n}",
                          String(
                            Math.round(
                              PROFILE_DEFAULT_BUFFER_SECS[mobilityProfile] / 60,
                            ),
                          ),
                        )}
                      </>
                    )}
                  </p>
                </div>
                <button
                  id="pre-stop-buffer-default-toggle"
                  role="switch"
                  aria-checked={leaveBufferOverrideSeconds === null}
                  aria-label={t(
                    "settings.pre_stop_buffer_use_default",
                    "Use profile default",
                  )}
                  onClick={() =>
                    setLeaveBufferOverrideSeconds(
                      leaveBufferOverrideSeconds === null
                        ? PROFILE_DEFAULT_BUFFER_SECS[mobilityProfile]
                        : null,
                    )
                  }
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    leaveBufferOverrideSeconds === null
                      ? "bg-accent"
                      : "bg-surface-overlay"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                      leaveBufferOverrideSeconds === null
                        ? "translate-x-5"
                        : ""
                    }`}
                  />
                </button>
              </div>
              {leaveBufferOverrideSeconds !== null && (
                <div className="mt-2">
                  <div className="flex justify-between">
                    <span className="text-sm text-fg">
                      {t("settings.pre_stop_buffer", "Pre-stop buffer")}
                    </span>
                    <span className="text-sm text-fg-muted">
                      {Math.round(leaveBufferOverrideSeconds / 60)}{" "}
                      {t("time.min", "min")}
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label={t(
                      "settings.pre_stop_buffer",
                      "Pre-stop buffer",
                    )}
                    min={0}
                    max={900}
                    step={60}
                    value={leaveBufferOverrideSeconds}
                    aria-valuetext={`${Math.round(leaveBufferOverrideSeconds / 60)} ${t("time.min", "min")}`}
                    onChange={(e) =>
                      setLeaveBufferOverrideSeconds(
                        parseInt(e.target.value, 10),
                      )
                    }
                    className="w-full mt-1 accent-accent"
                  />
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Navigation */}
        <section>
          <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
            {t("settings.navigation", "Navigation")}
          </h2>
          <div className="bg-surface-raised rounded-xl border border-divider px-4">
            <div className="flex items-center justify-between py-3 border-b border-divider">
              <div>
                <span id="settings-get-off-alarm-label" className="text-sm text-fg">{t("settings.get_off_alarm", "Get-off alarm")}</span>
                <p id="settings-get-off-alarm-desc" className="text-xs text-fg-muted">{t("settings.get_off_alarm_desc", "Vibrate and show a banner when approaching your destination stop")}</p>
              </div>
              <button
                role="switch"
                aria-checked={getOffAlarmEnabled}
                aria-labelledby="settings-get-off-alarm-label"
                aria-describedby="settings-get-off-alarm-desc"
                onClick={() => setGetOffAlarmEnabled(!getOffAlarmEnabled)}
                className={`relative w-11 h-6 rounded-full transition-colors ${getOffAlarmEnabled ? "bg-accent" : "bg-surface-overlay"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${getOffAlarmEnabled ? "translate-x-5" : ""}`} />
              </button>
            </div>
            <div className="flex items-center justify-between py-3">
              <div>
                <span id="settings-trip-notifications-label" className="text-sm text-fg">{t("settings.trip_notifications", "Trip notifications")}</span>
                <p id="settings-trip-notifications-desc" className="text-xs text-fg-muted">{t("settings.trip_notifications_desc", "Show browser notifications for trip events when the app is in the background")}</p>
              </div>
              <button
                role="switch"
                aria-checked={tripNotificationsEnabled}
                aria-labelledby="settings-trip-notifications-label"
                aria-describedby="settings-trip-notifications-desc"
                onClick={async () => {
                  if (!tripNotificationsEnabled) {
                    await requestNotificationPermission();
                  }
                  setTripNotificationsEnabled(!tripNotificationsEnabled);
                }}
                className={`relative w-11 h-6 rounded-full transition-colors ${tripNotificationsEnabled ? "bg-accent" : "bg-surface-overlay"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${tripNotificationsEnabled ? "translate-x-5" : ""}`} />
              </button>
            </div>
          </div>
        </section>

        {/* Advanced toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full py-3 text-sm font-medium text-accent hover:bg-accent/10 rounded-lg transition-colors flex items-center justify-center gap-1"
        >
          {t("settings.advanced", "Advanced")}
          <span className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`}>▼</span>
        </button>

        {showAdvanced && (
          <>
            <ErrorBoundary
              fallback={
                <div className="bg-surface-raised rounded-xl border border-divider p-4 text-sm text-fg-muted">
                  {t("settings.advanced_load_error", "Could not load advanced settings.")}
                </div>
              }
            >
              <Suspense
                fallback={<div className="h-20 bg-surface-overlay rounded-xl animate-pulse" />}
              >
                <AdvancedSettings />
              </Suspense>
            </ErrorBoundary>
            <ErrorBoundary
              fallback={
                <div className="bg-surface-raised rounded-xl border border-divider p-4 text-sm text-fg-muted">
                  {t("settings.privacy_load_error", "Could not load privacy settings.")}
                </div>
              }
            >
              <Suspense
                fallback={<div className="h-20 bg-surface-overlay rounded-xl animate-pulse" />}
              >
                <PrivacyLevelSection />
                <OfflinePrepSection />
              </Suspense>
            </ErrorBoundary>
            <ErrorBoundary
              fallback={
                <div className="bg-surface-raised rounded-xl border border-divider p-4 text-sm text-fg-muted">
                  {t("settings.optional_storage_load_error", "Could not load optional local-memory controls.")}
                </div>
              }
            >
              <Suspense
                fallback={<div className="h-20 bg-surface-overlay rounded-xl animate-pulse" />}
              >
                <PrivacyStorageSettings />
              </Suspense>
            </ErrorBoundary>
            <ErrorBoundary
              fallback={
                <div className="bg-surface-raised rounded-xl border border-divider p-4 text-sm text-fg-muted">
                  {t("settings.recents_purge_load_error", "Could not load the purge-recents control.")}
                </div>
              }
            >
              <Suspense
                fallback={<div className="h-20 bg-surface-overlay rounded-xl animate-pulse" />}
              >
                <RecentsPurgeControl />
              </Suspense>
            </ErrorBoundary>
            <ErrorBoundary
              fallback={
                <div className="bg-surface-raised rounded-xl border border-divider p-4 text-sm text-fg-muted">
                  {t("settings.data_deletion_load_error", "Could not load data-deletion controls.")}
                </div>
              }
            >
              <Suspense
                fallback={<div className="h-20 bg-surface-overlay rounded-xl animate-pulse" />}
              >
                <DataDeletionControls />
              </Suspense>
            </ErrorBoundary>
          </>
        )}

        {/* About */}
        <section>
          <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
            {t("settings.about", "About")}
          </h2>
          <div className="bg-surface-raised rounded-xl border border-divider p-4">
            <p className="text-sm text-fg-secondary">
              <span className="font-bold">PTN</span>
              {" — "}
              <span aria-live="polite">
                {huyloActive
                  ? HUYLO_FLASH_LABEL
                  : t("settings.about_text", "Public Transport Navigator")}
              </span>
            </p>
            {overthrow && (
              <div className="mt-2">
                <p className="text-xs text-fg-muted italic">{overthrow.label}</p>
                <p className="text-[11px] text-fg-muted/70 mt-0.5 italic">
                  {overthrow.subtext}
                </p>
              </div>
            )}
            <ErrorBoundary fallback={null} context="version-block">
              <Suspense fallback={<div className="h-12 mt-2" aria-hidden />}>
                <VersionBlock onClick={handleVersionClick} />
              </Suspense>
            </ErrorBoundary>
            <ErrorBoundary fallback={null} context="force-update-button">
              <Suspense fallback={null}>
                <ForceUpdateButton />
              </Suspense>
            </ErrorBoundary>
            <ProjectLinks />
            <Suspense fallback={null}>
              <PoiAttribution />
              <TransitAttribution />
            </Suspense>
          </div>
        </section>
      </div>
    </div>
  );
}
