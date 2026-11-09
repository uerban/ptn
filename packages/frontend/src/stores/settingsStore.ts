import { toggleRouteGroupSelection, type RouteGroup } from "../services/routeGroups.ts";
import { create } from "zustand";
import { LOOSE_POI_CATEGORIES, sanitizePoiCategories, type LoosePoiCategory } from "../config/poiCategories.ts";
import { persist } from "zustand/middleware";
import { createTolerantJSONStorage } from "../services/tolerantLocalStorage.ts";
import {
  isMapDetailMode,
  MAP_DETAIL_MODES,
  type MapDetailMode,
} from "../services/preferenceValues.ts";
import type { TransportMode } from "@pt/shared";
import {
  DEFAULT_URBAN_LOOKAHEAD_HOURS,
  DEFAULT_WALK_SPEED_MPS,
  DEFAULT_MAX_WALK_SECS,
} from "@pt/shared/constants";
import { resolveWalkParams, resolveWalkParamsOnSwitch, runSpeedMps, type MobilityProfile } from "@pt/shared/routing";
import { SUPPORTED_LOCALES, type SupportedLocale } from "../i18n/index.ts";
import {
  ACCESSIBILITY_SCHEME_VALUES,
  DEFAULT_MODE_COLORS,
  resolveRouteColor,
  type AccessibilityScheme,
} from "../utils/routeColor.ts";
import { effectiveVariant } from "../utils/appearance.ts";
import { canonicalCityId } from "../utils/cityId.ts";
import { CITIES } from "../config/cities.ts";
import { useCityStore } from "./cityStore.ts";
import type { ThirdPartyProviderId } from "../config/geocoderProviders.ts";
import { GEOCODER_PROVIDERS } from "../config/geocoderProviders.ts";
import { POI_FETCH_MODES, type PoiFetchMode } from "@pt/shared/poi";
import {
  ROUTING_PROVIDERS,
  type RoutingProviderId,
} from "../config/routingProviders.ts";

export type ThemeMode = "light" | "dark" | "system";
export type LanguageSetting = "auto" | SupportedLocale;
export { MAP_DETAIL_MODES, type MapDetailMode };
/**
 * Route-search layout variant:
 *   - consumer   : Citymapper-style card with time-proportional timeline bar (default)
 *   - power      : Dense timetable-style row with mono numerics
 *   - accessible : Large hit targets, each transit leg as its own row
 *
 * Derived from a readonly tuple so the literal union and the runtime
 * allow-list stay in sync — adding a variant here automatically extends
 * both the type and the validator used by persistence + setter.
 */
const ROUTE_SEARCH_VARIANTS = ["consumer", "power", "accessible"] as const;
export type RouteSearchVariant = (typeof ROUTE_SEARCH_VARIANTS)[number];

function isRouteSearchVariant(x: unknown): x is RouteSearchVariant {
  return (
    typeof x === "string" &&
    (ROUTE_SEARCH_VARIANTS as readonly string[]).includes(x)
  );
}

/**
 * Layout of the nearby-departures strip on the map (`ETACards`):
 *   - rows    : one scroll row per side of the street, soonest first (default)
 *   - columns : one column per line, the two sides stacked in a 2-row grid
 *
 * Both ship so user tests can pick one; the other is removed afterwards.
 */
export const ETA_CARDS_LAYOUTS = ["rows", "columns"] as const;
export type EtaCardsLayout = (typeof ETA_CARDS_LAYOUTS)[number];

export function isEtaCardsLayout(x: unknown): x is EtaCardsLayout {
  return (
    typeof x === "string" &&
    (ETA_CARDS_LAYOUTS as readonly string[]).includes(x)
  );
}

const SEARCH_PROVIDERS = ["local", "remote"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

function isSearchProvider(x: unknown): x is SearchProvider {
  return (
    typeof x === "string" &&
    (SEARCH_PROVIDERS as readonly string[]).includes(x)
  );
}

function isPoiFetchMode(x: unknown): x is PoiFetchMode {
  return typeof x === "string" && (POI_FETCH_MODES as readonly string[]).includes(x);
}

// Use-time clamp (Search/Settings/indicator + the gateRemoteRouting dispatch backstop) keeps the
// remote modes inert at the `local-only` privacy ceiling without a destructive merge() demotion
// (S2b-1 precedent) — the preference survives a later privacy-lowering.
export const ROUTING_MODES = ["on-device", "provider-fallback", "remote-primary"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export function isRoutingMode(x: unknown): x is RoutingMode {
  return typeof x === "string" && (ROUTING_MODES as readonly string[]).includes(x);
}

export const REMOTE_ROUTING_PROVIDERS = ["operator", "transitous"] as const;
export type RemoteRoutingProvider =
  | "operator"
  | RoutingProviderId;

export function isRemoteRoutingProvider(
  value: unknown,
): value is RemoteRoutingProvider {
  return (
    value === "operator" ||
    (typeof value === "string" && Object.hasOwn(ROUTING_PROVIDERS, value))
  );
}

interface SettingsState {
  theme: ThemeMode;
  resolvedTheme: "light" | "dark";
  preferredAdapter: string;
  language: LanguageSetting;
  departuresPerLine: number;
  maxPopupLines: number;
  urbanMode: boolean;
  urbanLookaheadHours: number;
  /** The starting view is Text mode (the persisted name predates the term). */
  scheduleMode: boolean;
  accessibilityScheme: AccessibilityScheme;
  highContrastEnabled: boolean;
  modeColorOverrides: Record<string, Record<string, string>>;
  mobilityProfile: MobilityProfile;
  walkSpeedMps: number;
  maxWalkSecs: number;
  runToCatch: boolean;
  /** Pre-stop buffer override in seconds. null = use PROFILE_DEFAULT_BUFFER_SECS[mobilityProfile]. 0 = explicit "no buffer". */
  leaveBufferOverrideSeconds: number | null;
  routeSearchVariant: RouteSearchVariant;
  /** Display preference for the map canvas. Privacy basemapMode can still force
   *  the effective map to local-only; this setting is the user's independent
   *  opt-in to skip the external basemap even when policy allows it. */
  mapDetailMode: MapDetailMode;
  excludedModes: TransportMode[];
  /** Global explicit opt-ins that take precedence over a city default. */
  enabledModes: TransportMode[];
  excludedRouteGroupsByCity: Record<string, string[]>;
  getOffAlarmEnabled: boolean;
  etaCardsEnabled: boolean;
  etaCardsLayout: EtaCardsLayout;
  tripNotificationsEnabled: boolean;
  enableFavoritesMigration: boolean;
  /** Compatibility flag for bundle sync; category setters keep it derived. */
  poiIncludeLooseTier: boolean;
  poiLooseCategories: LoosePoiCategory[];
  /** Distinguishes an explicit choice from the legacy default-off snapshot. */
  poiIncludeLooseTierUserSet: boolean;
  /** When true, the map flies to the user's GPS location on startup. */
  startupLocate: boolean;
  gpsMode: "enabled" | "until-locate" | "disabled";
  searchProvider: SearchProvider;
  /** Temporary Search UI choices, retained while device feedback settles defaults. */
  searchActiveFieldOnly: boolean;
  searchKeyboardFit: boolean;
  searchCompactRows: boolean;
  searchDismissOnScroll: boolean;
  /**
 * Standing routing source. `on-device` = the default; `provider-fallback` = on-device primary,
 * auto-fall-back to the server on failure/empty; `remote-primary` = server primary, signalled
 * fall-back to on-device on plan() rejection. This is a standing routing choice; both remote
 * modes are inert at the `local-only` ceiling.
 */
  routingMode: RoutingMode;
  /** Standing destination for remote routing strategies. The selected value
   * remains persisted when a stricter privacy floor makes it temporarily
   * inert, matching routingMode's non-destructive clamp. */
  routingProvider: RemoteRoutingProvider;
  /** Per-user POI fetch-mode override (user wins over operator default). */
  poiFetchModeOverride?: PoiFetchMode;
  thirdPartyProvider: ThirdPartyProviderId;
  thirdPartyApiKeys: Partial<Record<ThirdPartyProviderId, string>>;
  setUrbanMode: (enabled: boolean) => void;
  setUrbanLookaheadHours: (hours: number) => void;
  setScheduleMode: (enabled: boolean) => void;
  setTheme: (theme: ThemeMode) => void;
  setPreferredAdapter: (adapter: string) => void;
  setLanguage: (language: LanguageSetting) => void;
  setDeparturesPerLine: (n: number) => void;
  setMaxPopupLines: (n: number) => void;
  setAccessibilityScheme: (scheme: AccessibilityScheme) => void;
  setHighContrastEnabled: (enabled: boolean) => void;
  setModeColorOverride: (subModeId: string, color: string) => void;
  removeModeColorOverride: (subModeId: string) => void;
  resetModeColorOverrides: () => void;
  getModeColorOverridesForCity: (cityId: string) => Record<string, string>;
  setMobilityProfile: (profile: MobilityProfile) => void;
  setWalkSpeedMps: (speed: number) => void;
  setMaxWalkSecs: (secs: number) => void;
  setRunToCatch: (enabled: boolean) => void;
  setLeaveBufferOverrideSeconds: (seconds: number | null) => void;
  setRouteSearchVariant: (variant: RouteSearchVariant) => void;
  setMapDetailMode: (mode: MapDetailMode) => void;
  setExcludedModes: (modes: TransportMode[]) => void;
  toggleRouteGroup: (cityId: string, group: RouteGroup, groups: readonly RouteGroup[]) => void;
  toggleMode: (mode: TransportMode) => void;
  setGetOffAlarmEnabled: (enabled: boolean) => void;
  setEtaCardsEnabled: (enabled: boolean) => void;
  setEtaCardsLayout: (layout: EtaCardsLayout) => void;
  setTripNotificationsEnabled: (enabled: boolean) => void;
  setEnableFavoritesMigration: (enabled: boolean) => void;
  setPoiIncludeLooseTier: (enabled: boolean) => void;
  setPoiLooseCategories: (categories: LoosePoiCategory[]) => void;
  setStartupLocate: (enabled: boolean) => void;
  setGpsMode: (mode: "enabled" | "until-locate" | "disabled") => void;
  setSearchProvider: (provider: SearchProvider) => void;
  setSearchActiveFieldOnly: (enabled: boolean) => void;
  setSearchKeyboardFit: (enabled: boolean) => void;
  setSearchCompactRows: (enabled: boolean) => void;
  setSearchDismissOnScroll: (enabled: boolean) => void;
  setRoutingMode: (mode: RoutingMode) => void;
  setRoutingProvider: (provider: RemoteRoutingProvider) => void;
  setPoiFetchModeOverride: (mode: PoiFetchMode | undefined) => void;
  setThirdPartyProvider: (provider: ThirdPartyProviderId) => void;
  setThirdPartyApiKey: (provider: ThirdPartyProviderId, key: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  // NaN guard: `Math.min(NaN, x)` returns NaN, which would silently slip
  // through and poison RAPTOR walk-time arithmetic. Coerce non-finite
  // input to the lower bound — the store-level setters are the input
  // boundary for slider / typed values, so this is the right seam.
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

// Persisted boolean rehydration: take the stored value only when it's an
// actual boolean, else fall back to the current default. One helper instead
// of a per-field ternary keeps every boolean setting on the same coercion
// and removes the copy-paste hazard of referencing the wrong sibling field.
function coerceBool(stored: unknown, fallback: boolean): boolean {
  return typeof stored === "boolean" ? stored : fallback;
}

function sanitizeApiKeys(
  stored: unknown,
): Partial<Record<ThirdPartyProviderId, string>> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const result: Partial<Record<ThirdPartyProviderId, string>> = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (Object.hasOwn(GEOCODER_PROVIDERS, key) && typeof value === "string" && value.length > 0) {
      result[key as ThirdPartyProviderId] = value;
    }
  }
  return result;
}

/** Default pre-stop buffer in seconds per mobility profile. */
export const PROFILE_DEFAULT_BUFFER_SECS: Record<MobilityProfile, number> = {
  default: 180,
  wheelchair: 300,
  vision_impaired: 300,
  bicycle: 180,
};

const VALID_TRANSPORT_MODES = Object.keys(DEFAULT_MODE_COLORS);

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Migrate persisted excludedModes: legacy CABLE_CAR → CABLE_TRAM + AERIAL
 *  (old CABLE_CAR covered route_types 5 AND 6); drop unknown strings. */
export function migrateExcludedModes(raw: unknown[]): TransportMode[] {
  const validSet = new Set(VALID_TRANSPORT_MODES);
  const out = new Set<TransportMode>();
  for (const m of raw) {
    if (typeof m !== "string" || m.length === 0) continue;
    if (m === "CABLE_CAR") { out.add("CABLE_TRAM"); out.add("AERIAL"); continue; }
    if (validSet.has(m)) out.add(m as TransportMode);
  }
  return [...out];
}

/** Best-effort: remap a per-city CABLE_CAR colour-override key to CABLE_TRAM,
 *  unless a CABLE_TRAM key already exists (don't clobber). */
export function migrateModeColorOverrideKeys(
  overrides: Record<string, string>,
): Record<string, string> {
  if (!("CABLE_CAR" in overrides)) return { ...overrides };
  const { CABLE_CAR, ...rest } = overrides;
  if ("CABLE_TRAM" in rest) return rest; // existing wins
  return { ...rest, CABLE_TRAM: CABLE_CAR };
}

function sanitizeModeColorOverrides(
  stored: Record<string, string> | undefined,
  fallback: Record<string, string>,
): Record<string, string> {
  if (!stored || typeof stored !== "object") return fallback;
  const migrated = migrateModeColorOverrideKeys(stored as Record<string, string>);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(migrated)) {
    if (
      typeof key === "string" &&
      key.length > 0 &&
      typeof value === "string" &&
      HEX_COLOR_RE.test(value)
    ) {
      result[key] = value.length === 4
        ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toLowerCase()
        : value.toLowerCase();
    }
  }
  return result;
}

/** Legacy mode keys that no longer appear in VALID_TRANSPORT_MODES but must
 *  still be recognised as the OLD FLAT override shape so their colour is
 *  migrated (via migrateModeColorOverrideKeys in sanitizeModeColorOverrides)
 *  rather than dropped. CABLE_CAR was removed from the mode union in v6
 *  step-A; sanitizeModeColorOverrides remaps the key CABLE_CAR → CABLE_TRAM. */
const LEGACY_OVERRIDE_KEYS = new Set(["CABLE_CAR"]);

function isOldFlatOverrides(obj: Record<string, unknown>): boolean {
  const entries = Object.entries(obj);
  if (entries.length === 0) return false;
  return entries.every(
    ([key, value]) =>
      (VALID_TRANSPORT_MODES.includes(key) || LEGACY_OVERRIDE_KEYS.has(key)) &&
      typeof value === "string",
  );
}

export function sanitizePerCityOverrides(
  stored: unknown,
  fallback: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return fallback;

  const obj = stored as Record<string, unknown>;

  if (isOldFlatOverrides(obj)) {
    const cityId = useCityStore.getState().activeCity.id;
    const sanitized = sanitizeModeColorOverrides(
      obj as Record<string, string>,
      {},
    );
    return Object.keys(sanitized).length > 0 ? { [cityId]: sanitized } : {};
  }

  const result: Record<string, Record<string, string>> = {};
  for (const [cityId, cityOverrides] of Object.entries(obj)) {
    if (cityOverrides && typeof cityOverrides === "object" && !Array.isArray(cityOverrides)) {
      const sanitized = sanitizeModeColorOverrides(
        cityOverrides as Record<string, string>,
        {},
      );
      if (Object.keys(sanitized).length > 0) {
        result[cityId] = sanitized;
      }
    }
  }
  return result;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: "system",
      resolvedTheme: (typeof window !== "undefined"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : "light") as "light" | "dark",
      preferredAdapter: "raptor",
      language: "auto",
      departuresPerLine: 3,
      maxPopupLines: 4,
      urbanMode: true,
      urbanLookaheadHours: DEFAULT_URBAN_LOOKAHEAD_HOURS,
      scheduleMode: false,
      accessibilityScheme: "none",
      highContrastEnabled: false,
      modeColorOverrides: {},
      mobilityProfile: "default" satisfies MobilityProfile,
      walkSpeedMps: DEFAULT_WALK_SPEED_MPS,
      maxWalkSecs: DEFAULT_MAX_WALK_SECS,
      runToCatch: false,
      leaveBufferOverrideSeconds: null,
      routeSearchVariant: "consumer" satisfies RouteSearchVariant,
      mapDetailMode: "detailed" satisfies MapDetailMode,
      excludedModes: [],
      enabledModes: [],
      excludedRouteGroupsByCity: {},
      getOffAlarmEnabled: true,
      etaCardsEnabled: true,
      etaCardsLayout: "rows" satisfies EtaCardsLayout,
      tripNotificationsEnabled: true,
      enableFavoritesMigration: false,
      poiIncludeLooseTier: true,
      poiLooseCategories: [...LOOSE_POI_CATEGORIES],
      poiIncludeLooseTierUserSet: false,
      startupLocate: false,
      gpsMode: "enabled",
      searchProvider: "local" satisfies SearchProvider,
      searchActiveFieldOnly: true,
      searchKeyboardFit: true,
      searchCompactRows: true,
      searchDismissOnScroll: true,
      routingMode: "on-device" satisfies RoutingMode,
      routingProvider: "operator" satisfies RemoteRoutingProvider,
      poiFetchModeOverride: undefined,
      thirdPartyProvider: "nominatim" as ThirdPartyProviderId,
      thirdPartyApiKeys: {},
      setUrbanMode: (enabled) => set({ urbanMode: enabled }),
      setScheduleMode: (enabled) => set({ scheduleMode: enabled }),
      setUrbanLookaheadHours: (hours) =>
        set({ urbanLookaheadHours: clamp(hours, 1, 6) }),
      setTheme: (theme) => {
        set({ theme, resolvedTheme: resolveTheme(theme) });
        applyTheme(theme);
      },
      setPreferredAdapter: (adapter) =>
        set({ preferredAdapter: adapter }),
      setLanguage: (language) => set({ language }),
      setDeparturesPerLine: (n) =>
        set({ departuresPerLine: clamp(n, 1, 5) }),
      setMaxPopupLines: (n) =>
        set({ maxPopupLines: clamp(n, 2, 8) }),
      setAccessibilityScheme: (scheme) => {
        set({ accessibilityScheme: scheme });
        applyA11yScheme(scheme);
      },
      setHighContrastEnabled: (enabled) => set({ highContrastEnabled: enabled }),
      setModeColorOverride: (mode, color) => {
        if (!HEX_COLOR_RE.test(color)) return;
        const { accessibilityScheme, resolvedTheme } = get();
        const defaultColor = resolveRouteColor(undefined, mode as TransportMode, {}, accessibilityScheme, resolvedTheme);
        const normalizedInput = color.length === 4
          ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase()
          : color.toLowerCase();
        if (normalizedInput === defaultColor.toLowerCase()) return;
        const cityId = useCityStore.getState().activeCity.id;
        set((state) => ({
          modeColorOverrides: {
            ...state.modeColorOverrides,
            [cityId]: { ...(state.modeColorOverrides[cityId] ?? {}), [mode]: normalizedInput },
          },
        }));
      },
      removeModeColorOverride: (mode) => {
        const cityId = useCityStore.getState().activeCity.id;
        set((state) => {
          const cityOverrides = state.modeColorOverrides[cityId];
          if (!cityOverrides || !(mode in cityOverrides)) return {};
          const { [mode]: _, ...rest } = cityOverrides;
          if (Object.keys(rest).length === 0) {
            const { [cityId]: __, ...otherCities } = state.modeColorOverrides;
            return { modeColorOverrides: otherCities };
          }
          return {
            modeColorOverrides: { ...state.modeColorOverrides, [cityId]: rest },
          };
        });
      },
      resetModeColorOverrides: () => {
        const cityId = useCityStore.getState().activeCity.id;
        set((state) => {
          const { [cityId]: _, ...rest } = state.modeColorOverrides;
          return { modeColorOverrides: rest };
        });
      },
      getModeColorOverridesForCity: (cityId) => get().modeColorOverrides[cityId] ?? {},
      setMobilityProfile: (profile) => {
        const current = get();
        // Re-choosing the active profile is not a switch: keep a speed the
        // rider raised since (the vision-impaired start applies once).
        const resolve = profile === current.mobilityProfile ? resolveWalkParams : resolveWalkParamsOnSwitch;
        const resolved = resolve(profile, {
          walkSpeedMps: current.walkSpeedMps,
          maxWalkSecs: current.maxWalkSecs,
        });
        const updates: Partial<SettingsState> = {
          mobilityProfile: profile,
          walkSpeedMps: resolved.walkSpeedMps,
          maxWalkSecs: resolved.maxWalkSecs,
        };
        if (profile === "wheelchair" || profile === "vision_impaired") {
          updates.runToCatch = false;
        }
        set(updates);
        applyVariant(get().routeSearchVariant, profile);
      },
      // Apply the slider clamp first, then route through the resolver so the
      // wheelchair cap is enforced even on programmatic / e2e / dev-tools
      // setter calls (not just slider events). Without this, a caller that
      // bypasses the Settings UI could leave the store in an inconsistent
      // state — `mobilityProfile === "wheelchair"` AND `walkSpeedMps > cap`.
      setWalkSpeedMps: (speed) => {
        const clamped = clamp(speed, 0.5, 3.0);
        const resolved = resolveWalkParams(get().mobilityProfile, {
          walkSpeedMps: clamped,
          maxWalkSecs: get().maxWalkSecs,
        });
        set({ walkSpeedMps: resolved.walkSpeedMps });
      },
      setMaxWalkSecs: (secs) => set({ maxWalkSecs: clamp(secs, 60, 3600) }),
      setRunToCatch: (enabled) => set({ runToCatch: enabled }),
      setLeaveBufferOverrideSeconds: (seconds) => {
        if (seconds === null) {
          set({ leaveBufferOverrideSeconds: null });
          return;
        }
        if (Number.isFinite(seconds)) {
          set({ leaveBufferOverrideSeconds: clamp(seconds, 0, 1800) });
          return;
        }
        // Non-finite (NaN, Infinity, -Infinity, anything not-null-not-finite):
        // surface the silent drop so the call site bug is visible. Common
        // trigger: <input type="number" valueAsNumber> emits NaN when cleared.
        // Callers should pass `null` to clear the override; we don't auto-clear
        // here because that would mask a real "stop applying my override"
        // intent vs. an accidental clear.
        console.warn(
          "[settingsStore] setLeaveBufferOverrideSeconds rejected non-finite value; pass null to clear",
          { received: seconds },
        );
      },
      setRouteSearchVariant: (variant) => {
        if (isRouteSearchVariant(variant)) {
          set({ routeSearchVariant: variant });
          applyVariant(variant, get().mobilityProfile);
        }
      },
      setMapDetailMode: (mode) => {
        if (isMapDetailMode(mode)) set({ mapDetailMode: mode });
      },
      setExcludedModes: (modes) => set({ excludedModes: modes,
        enabledModes: VALID_TRANSPORT_MODES.filter(mode => !modes.includes(mode as TransportMode)) as TransportMode[] }),
      setGetOffAlarmEnabled: (enabled) => set({ getOffAlarmEnabled: enabled }),
      setEtaCardsEnabled: (enabled) => set({ etaCardsEnabled: enabled }),
      setEtaCardsLayout: (layout) => {
        if (isEtaCardsLayout(layout)) set({ etaCardsLayout: layout });
      },
      setTripNotificationsEnabled: (enabled) => set({ tripNotificationsEnabled: enabled }),
      setEnableFavoritesMigration: (enabled) => set({ enableFavoritesMigration: enabled }),
      setPoiIncludeLooseTier: (enabled) => set({
        poiIncludeLooseTier: enabled,
        poiLooseCategories: enabled ? [...LOOSE_POI_CATEGORIES] : [],
        poiIncludeLooseTierUserSet: true,
      }),
      setPoiLooseCategories: (categories) => {
        const selected = sanitizePoiCategories(categories);
        set({ poiLooseCategories: selected, poiIncludeLooseTier: selected.length > 0, poiIncludeLooseTierUserSet: true });
      },
      setStartupLocate: (enabled) => set({ startupLocate: enabled }),
      setGpsMode: (gpsMode) => set({ gpsMode }),
      setSearchActiveFieldOnly: (enabled) => set({ searchActiveFieldOnly: enabled }),
      setSearchKeyboardFit: (enabled) => set({ searchKeyboardFit: enabled }),
      setSearchCompactRows: (enabled) => set({ searchCompactRows: enabled }),
      setSearchDismissOnScroll: (enabled) => set({ searchDismissOnScroll: enabled }),
      setSearchProvider: (provider) => {
        if (isSearchProvider(provider)) set({ searchProvider: provider });
      },
      setRoutingMode: (mode) => {
        if (isRoutingMode(mode)) set({ routingMode: mode });
      },
      setRoutingProvider: (provider) => {
        if (isRemoteRoutingProvider(provider)) set({ routingProvider: provider });
      },
      setPoiFetchModeOverride: (mode) =>
        set({ poiFetchModeOverride: mode === undefined ? undefined : (isPoiFetchMode(mode) ? mode : undefined) }),
      setThirdPartyProvider: (provider) => {
        if (Object.hasOwn(GEOCODER_PROVIDERS, provider)) {
          set({ thirdPartyProvider: provider });
        }
      },
      setThirdPartyApiKey: (provider, key) => {
        if (!Object.hasOwn(GEOCODER_PROVIDERS, provider)) return;
        set((state) => ({
          thirdPartyApiKeys: { ...state.thirdPartyApiKeys, [provider]: key },
        }));
      },
      toggleRouteGroup: (cityId, group, groups) => set((state) => {
        const activeCity = useCityStore.getState().activeCity;
        const defaults = (activeCity.id === cityId ? activeCity : CITIES.find(city => city.id === cityId))?.defaultExcludedModes ?? [];
        const effective = effectiveExcludedModes(state, defaults);
        const wasExcluded = effective.includes(group.parentMode);
        const next = toggleRouteGroupSelection(effective, state.excludedRouteGroupsByCity[cityId] ?? [], group, groups);
        return {
          excludedModes: wasExcluded ? state.excludedModes.filter(mode => mode !== group.parentMode) : state.excludedModes,
          enabledModes: wasExcluded ? [...new Set([...state.enabledModes, group.parentMode])] : state.enabledModes,
          excludedRouteGroupsByCity: {...state.excludedRouteGroupsByCity, [cityId]: next.excludedGroups},
        };
      }),
      toggleMode: (mode) => set((state) => {
        const excluded = effectiveExcludedModes(state, useCityStore.getState().activeCity.defaultExcludedModes ?? []).includes(mode);
        return {
          excludedModes: excluded ? state.excludedModes.filter(value => value !== mode) : [...state.excludedModes, mode],
          enabledModes: excluded ? [...new Set([...state.enabledModes, mode])] : state.enabledModes.filter(value => value !== mode),
        };
      }),
    }),
    {
      name: "ptn-settings",
      storage: createTolerantJSONStorage(),
      merge: (persisted, current) => {
        const stored = persisted as Partial<SettingsState> & { accessibilityScheme?: string } | undefined;
        const validThemes: ThemeMode[] = ["light", "dark", "system"];
        const VALID_MOBILITY_PROFILES: MobilityProfile[] = ["default", "wheelchair", "vision_impaired", "bicycle"];
        const validLanguages: readonly string[] = ["auto", ...SUPPORTED_LOCALES];
        const validAdapters = ["raptor", "motis"];
        const mergedTheme = validThemes.includes(stored?.theme as ThemeMode)
          ? (stored!.theme as ThemeMode)
          : current.theme;

        // Migrate legacy "high-contrast" scheme to universal + highContrastEnabled
        let migratedScheme: string | undefined = stored?.accessibilityScheme;
        let migratedHighContrast = stored?.highContrastEnabled;
        if (migratedScheme === "high-contrast") {
          migratedScheme = "universal";
          migratedHighContrast = true;
        }

        // Preserve the deployed effective switch when upgrading to category choices.
        const poiLooseCategories = sanitizePoiCategories(stored?.poiLooseCategories,
          stored?.poiIncludeLooseTierUserSet === true
            ? coerceBool(stored.poiIncludeLooseTier, current.poiIncludeLooseTier)
            : true);

        return {
          ...current,
          ...stored,
          theme: mergedTheme,
          resolvedTheme: resolveTheme(mergedTheme),
          preferredAdapter: validAdapters.includes(stored?.preferredAdapter as string)
            ? stored!.preferredAdapter!
            : current.preferredAdapter,
          language: validLanguages.includes(stored?.language as string)
            ? (stored!.language as LanguageSetting)
            : current.language,
          departuresPerLine: clamp(
            Number(stored?.departuresPerLine) || current.departuresPerLine,
            1,
            5
          ),
          maxPopupLines: clamp(
            Number(stored?.maxPopupLines) || current.maxPopupLines,
            2,
            8
          ),
          urbanMode: typeof stored?.urbanMode === "boolean"
            ? stored.urbanMode
            : current.urbanMode,
          scheduleMode: typeof stored?.scheduleMode === "boolean"
            ? stored.scheduleMode
            : current.scheduleMode,
          urbanLookaheadHours: clamp(
            Number(stored?.urbanLookaheadHours) || current.urbanLookaheadHours,
            1,
            6
          ),
          accessibilityScheme: ACCESSIBILITY_SCHEME_VALUES.includes(
            migratedScheme as AccessibilityScheme
          )
            ? (migratedScheme as AccessibilityScheme)
            : current.accessibilityScheme,
          highContrastEnabled: typeof migratedHighContrast === "boolean"
            ? migratedHighContrast
            : current.highContrastEnabled,
          modeColorOverrides: migrateCityColors(sanitizePerCityOverrides(
            stored?.modeColorOverrides,
            (current as SettingsState).modeColorOverrides,
          )),
          mobilityProfile: VALID_MOBILITY_PROFILES.includes(stored?.mobilityProfile as MobilityProfile)
            ? (stored!.mobilityProfile as MobilityProfile)
            : current.mobilityProfile,
          walkSpeedMps: typeof stored?.walkSpeedMps === "number"
            ? clamp(stored.walkSpeedMps, 0.5, 3.0)
            : current.walkSpeedMps,
          maxWalkSecs: typeof stored?.maxWalkSecs === "number"
            ? clamp(stored.maxWalkSecs, 60, 3600)
            : current.maxWalkSecs,
          runToCatch: coerceBool(stored?.runToCatch, current.runToCatch),
          leaveBufferOverrideSeconds:
            stored?.leaveBufferOverrideSeconds === null
              ? null
              : Number.isFinite(stored?.leaveBufferOverrideSeconds)
                ? clamp(stored!.leaveBufferOverrideSeconds as number, 0, 1800)
                : current.leaveBufferOverrideSeconds,
          routeSearchVariant: isRouteSearchVariant(stored?.routeSearchVariant)
            ? stored.routeSearchVariant
            : current.routeSearchVariant,
          mapDetailMode: isMapDetailMode(stored?.mapDetailMode)
            ? stored.mapDetailMode
            : current.mapDetailMode,
          excludedRouteGroupsByCity: Object.entries(stored?.excludedRouteGroupsByCity ?? {}).reduce<Record<string, string[]>>((result, [city, value]) => {
            if (!Array.isArray(value)) return result;
            const owner = canonicalCityId(city);
            result[owner] = [...new Set([...(result[owner] ?? []), ...value.filter((item): item is string => typeof item === "string")])];
            return result;
          }, {}),
          excludedModes: Array.isArray(stored?.excludedModes)
            ? migrateExcludedModes(stored!.excludedModes as unknown[])
            : current.excludedModes,
          enabledModes: Array.isArray(stored?.enabledModes) ? migrateExcludedModes(stored.enabledModes) : [],
          getOffAlarmEnabled: coerceBool(stored?.getOffAlarmEnabled, current.getOffAlarmEnabled),
          etaCardsEnabled: coerceBool(stored?.etaCardsEnabled, current.etaCardsEnabled),
          etaCardsLayout: isEtaCardsLayout(stored?.etaCardsLayout)
            ? stored.etaCardsLayout
            : current.etaCardsLayout,
          tripNotificationsEnabled: coerceBool(stored?.tripNotificationsEnabled, current.tripNotificationsEnabled),
          enableFavoritesMigration: coerceBool(stored?.enableFavoritesMigration, current.enableFavoritesMigration),
          poiLooseCategories,
          poiIncludeLooseTier: poiLooseCategories.length > 0,
          poiIncludeLooseTierUserSet: stored?.poiIncludeLooseTierUserSet === true,
          searchActiveFieldOnly: coerceBool(stored?.searchActiveFieldOnly, current.searchActiveFieldOnly),
          searchKeyboardFit: coerceBool(stored?.searchKeyboardFit, current.searchKeyboardFit),
          searchCompactRows: coerceBool(stored?.searchCompactRows, current.searchCompactRows),
          searchDismissOnScroll: coerceBool(stored?.searchDismissOnScroll, current.searchDismissOnScroll),
          startupLocate: coerceBool(stored?.startupLocate, current.startupLocate),
          gpsMode: (stored?.gpsMode === "enabled" || stored?.gpsMode === "until-locate" || stored?.gpsMode === "disabled")
            ? stored.gpsMode : current.gpsMode,
          searchProvider: isSearchProvider(stored?.searchProvider)
            ? stored.searchProvider
            : current.searchProvider,
          routingMode: isRoutingMode(stored?.routingMode)
            ? stored.routingMode
            : current.routingMode,
          routingProvider: isRemoteRoutingProvider(stored?.routingProvider)
            ? stored.routingProvider
            : current.routingProvider,
          poiFetchModeOverride: isPoiFetchMode(stored?.poiFetchModeOverride)
            ? stored.poiFetchModeOverride
            : undefined,
          thirdPartyProvider:
            typeof stored?.thirdPartyProvider === "string" &&
            Object.hasOwn(GEOCODER_PROVIDERS, stored.thirdPartyProvider)
              ? (stored.thirdPartyProvider as ThirdPartyProviderId)
              : current.thirdPartyProvider,
          thirdPartyApiKeys: sanitizeApiKeys(stored?.thirdPartyApiKeys),
        };
      },
    }
  )
);

function resolveTheme(theme: ThemeMode): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return theme;
}

function applyTheme(theme: ThemeMode) {
  const resolved = resolveTheme(theme);
  document.documentElement.setAttribute("data-theme", resolved);
}

function applyA11yScheme(scheme: AccessibilityScheme) {
  if (scheme === "none") {
    document.documentElement.removeAttribute("data-a11y-scheme");
  } else {
    document.documentElement.setAttribute("data-a11y-scheme", scheme);
  }
}

function applyVariant(variant: RouteSearchVariant, mobility: MobilityProfile) {
  document.documentElement.setAttribute("data-variant", effectiveVariant(variant, mobility));
}

// Apply theme and accessibility scheme on load
if (typeof window !== "undefined") {
  const stored = localStorage.getItem("ptn-settings");
  let theme: ThemeMode = "system";
  let a11yScheme: AccessibilityScheme = "none";
  let variant: RouteSearchVariant = "consumer";
  let mobility: MobilityProfile = "default";
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      const raw = parsed.state?.theme;
      theme = (raw === "light" || raw === "dark" || raw === "system") ? raw : "system";
      const rawScheme = parsed.state?.accessibilityScheme;
      if (ACCESSIBILITY_SCHEME_VALUES.includes(rawScheme)) {
        a11yScheme = rawScheme;
      }
      if (isRouteSearchVariant(parsed.state?.routeSearchVariant)) {
        variant = parsed.state.routeSearchVariant;
      }
      const rawMobility = parsed.state?.mobilityProfile;
      if (rawMobility === "wheelchair" || rawMobility === "vision_impaired" || rawMobility === "default" || rawMobility === "bicycle") {
        mobility = rawMobility;
      }
    } catch (err) {
      console.warn("Failed to parse persisted settings, using defaults:", err);
    }
  }
  applyTheme(theme);
  applyA11yScheme(a11yScheme);
  applyVariant(variant, mobility);

  // Listen for system preference changes when in "system" mode
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const onThemeChange = () => {
    const current = useSettingsStore.getState().theme;
    if (current === "system") {
      applyTheme("system");
      useSettingsStore.setState({ resolvedTheme: resolveTheme("system") });
    }
  };
  mql.addEventListener("change", onThemeChange);
}

/**
 * Resolve the pre-stop buffer in seconds.
 *
 * Returns the user-configured override when set (including 0, "explicit no buffer"),
 * otherwise the per-profile default from PROFILE_DEFAULT_BUFFER_SECS.
 */
export function selectPreStopBufferSeconds(state: SettingsState): number {
  return typeof state.leaveBufferOverrideSeconds === "number"
    ? state.leaveBufferOverrideSeconds
    : PROFILE_DEFAULT_BUFFER_SECS[state.mobilityProfile];
}

/**
 * How many times faster than their walk the rider runs, for the route cards'
 * catch advice — or undefined when nobody should be told to run. Mirrors the
 * planner's own gate in `findReachableStops`: run-to-catch on and not a
 * wheelchair profile.
 */
export function selectRunSpeedRatio(state: SettingsState): number | undefined {
  if (!state.runToCatch || state.mobilityProfile === "wheelchair") return undefined;
  return runSpeedMps(state.walkSpeedMps) / state.walkSpeedMps;
}


/** City policy is derived; visiting a city never changes global preferences. */
export function effectiveExcludedModes(
  state: {excludedModes: TransportMode[]; enabledModes?: TransportMode[]},
  defaults: readonly TransportMode[] = [],
): TransportMode[] {
  const additions = defaults.filter(mode => !state.excludedModes.includes(mode) && !state.enabledModes?.includes(mode));
  return additions.length ? [...state.excludedModes, ...additions] : state.excludedModes;
}


function migrateCityColors(colors: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  if (!colors.gdansk) return colors;
  const {gdansk, ...others} = colors;
  return {...others, tricity: {...gdansk, ...others.tricity}};
}
