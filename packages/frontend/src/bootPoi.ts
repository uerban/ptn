import type { SelfHostedGeocoderConfig } from "@pt/shared";
import { syncAddressSearch } from "./services/addressSearchLoader.ts";
import { loadPoiBundle, poiCityIds } from "./services/poiLoader.ts";
import {
  syncPoiForCity,
  registerActiveTileLoader,
  disposeActiveTileLoaders,
} from "./services/poiSync.ts";
import { resolvePoiFetchMode } from "./services/poiFetchMode.ts";
import {
  getActiveCityPoiTiling,
  getCityPoiTiling,
} from "./services/poiManifest.ts";
import { createTileLoader } from "./services/tileLoader.ts";
import { useCityStore } from "./stores/cityStore.ts";
import { useSettingsStore } from "./stores/settingsStore.ts";
import { geocoderRegistry } from "./services/geocoder/instance.ts";
import { setSearchModeAccessor, setGeocoderPresentAccessor, setThirdPartyEgressAccessor, ADDR_AUG_ENABLED } from "./services/searchSuggestions.ts";
import { getPolicy } from "./stores/privacyStore.ts";
import { isTransitousAllowed } from "./services/transitousAvailability.ts";
import {
  setRuntimeGeocoderConfig,
  syncSelfHostedRegistration,
  hasServerSideGeocoder,
} from "./services/geocoder/registerSelfHosted.ts";
import { reportError } from "./services/errorReporter.ts";
import { scheduleIdle } from "./utils/idle.ts";

// IMPORT-CYCLE INVERSION (Must-fix 2): inject the registry's active-mode
// accessor HERE — bootPoi.ts already depends on poiFetchMode.ts, so it is the
// correct injection site. instance.ts imports nothing from the resolution layer
// (no instance.ts → poiFetchMode.ts → registerSelfHosted.ts → instance.ts
// cycle). The accessor is consulted only at forward/reverse time (lazy), so this
// is safe to call at module-eval. Until this runs, the registry defaults to
// "never server-side" (the local/third-party tiers are not gated) — boot wires
// it before the first query.
// The registry accessor (existing, #278) and the search accessor (new, this
// stage) MUST be co-located and resolve the IDENTICAL mode for the same active
// city (single source of truth). Keep these two lines adjacent so a single
// grep finds both; a regression in one cannot silently leak a server-side-search-
// with-local/third-party-tier-open state.
geocoderRegistry.setActiveModeAccessor(() =>
  resolvePoiFetchMode(useCityStore.getState().activeCity.id),
);
setSearchModeAccessor((cityId) => resolvePoiFetchMode(cityId));
// Second capability accessor: "geocoder present?" over the SAME hasServerSideGeocoder read, kept
// adjacent to the mode accessors so a single grep finds the full search-time injection set. No new
// import edge (bootPoi already imports hasServerSideGeocoder).
setGeocoderPresentAccessor((cityId) => hasServerSideGeocoder(cityId));
// Third capability accessor: the third-party egress gate for remote STOP search.
// Remote stop search reaches transitous through the backend proxy, so it passes
// the SAME two axes as remote routing — the operator hop does not exempt it
// (services/transitousAvailability.ts). Read lazily per query so a privacy-level
// change takes effect without a reload. Kept adjacent to the accessors above so
// one grep finds the full search-time injection set.
setThirdPartyEgressAccessor(() => isTransitousAllowed(getPolicy()));

/** Max wait for the single /geocoder-config.json fetch before boot proceeds.
 *  Bounds the awaited fetch on the common UNCONFIGURED path so a 404/offline-hang
 *  does not block eager-search warmup indefinitely (Should-fix 13). On timeout the
 *  config registers null — the geocoder adapter is simply absent; the POI corpus
 *  decision is residency-posture-driven and does not depend on this fetch (Plan-1b
 * ). The per-city CityConfig.geocoder path is synchronous (never times out). */
const GEOCODER_CONFIG_TIMEOUT_MS = 3000;   // one-shot fetch cap

/** One timeout-bounded fetch of /geocoder-config.json. Returns the parsed
 *  self-hosted config, or null for ANY non-self-hosted outcome: a definitive
 *  "no config" (204/404/410/empty 200 body / present-but-not-`self-hosted`), a
 *  malformed body, a 5xx, or a timeout/network error. Post-Plan-1b there is no
 *  defer/retry — a transiently-unavailable config registers null (the self-hosted
 *  geocoder is absent, so address augmentation will not arm until reload), and the
 *  POI corpus dispatch is driven by the resolved residency posture, not this fetch.
 * Spec: privacy-governed-data-residency- */
async function attemptLoadGeocoderConfig(): Promise<SelfHostedGeocoderConfig | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODER_CONFIG_TIMEOUT_MS);
  try {
    const res = await fetch("/geocoder-config.json", {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (res.status === 204 || res.status === 404 || res.status === 410) {
      console.info("[geocoder-config] none shipped (status %d) — per-city/on-device only", res.status);
      return null;
    }
    if (res.ok) {
      const body = (await res.text()).trim();
      if (body === "") {
        console.info("[geocoder-config] empty 200 body — none shipped, per-city/on-device only");
        return null;
      }
      let cfg: unknown;
      try {
        cfg = JSON.parse(body);
      } catch {
        console.warn("[geocoder-config] 200 with unparseable body — treating as no config");
        return null;
      }
      return cfg && typeof cfg === "object" && "kind" in cfg &&
        (cfg as SelfHostedGeocoderConfig).kind === "self-hosted"
        ? (cfg as SelfHostedGeocoderConfig)
        : null;
    }
    console.warn("[geocoder-config] unexpected status %d — treating as no config", res.status);
    return null;
  } catch (err) {
    console.warn("[geocoder-config] fetch failed/timed out — treating as no config:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch /geocoder-config.json once (timeout-bounded), cache the resolved config for the
 * self-hosted geocoder, and register it for the ACTIVE city (per-city override beats JSON).
 * Awaited at boot before the first syncPoi() so the geocoder adapter is wired before the first
 * query. Post-Plan-1b this no longer gates the POI corpus: there is no configResolution state,
 * no corpus defer, and no detached retry — a non-answer registers null and boot proceeds. The
 * corpus dispatch is residency-posture-driven (server-side suppresses via the mode path; local
 * modes load immediately).
 */
export async function loadGeocoderConfig(): Promise<void> {
  const json = await attemptLoadGeocoderConfig();
  setRuntimeGeocoderConfig(json);
  syncSelfHostedRegistration(useCityStore.getState().activeCity.id);
}

let lastCityId: string | null = null;
let lastLoose: boolean | null = null;
let lastMode: ReturnType<typeof resolvePoiFetchMode> | null = null;
let lastRegisteredCityId: string | null = null;
let forcedResync: Promise<void> | null = null;

/**
 * Names the resolution distinction the `mode` value cannot carry on its own: a per-USER
 * override (rung 1) vs an OPERATOR default (per-city CityConfig, the global VITE default, or
 * the eager floor — all collapse to one label, exactly as the prior non-override/non-geocoder
 * path already did). The geocoder branch ("runtime-json"/"city-config") was dropped with
 * precedence rung 2 — geocoder presence is now reported by the separate `augmentEligible`
 * breadcrumb field.
 */
function resolutionSource(_cityId: string): "user-override" | "operator-default" {
  if (useSettingsStore.getState().poiFetchModeOverride !== undefined) return "user-override";
  return "operator-default";
}

function runPoiSync(force: boolean): Promise<void> | null {
  const frontendCityId = useCityStore.getState().activeCity.id;

  // PROLOGUE — runs ABOVE the lastMode guard so a city swap re-registers even
  // when the resolved mode is unchanged. Register/unregister FIRST, then
  // resolve+dispatch (AC-12 asserts registration precedes the dispatch).
  if (frontendCityId !== lastRegisteredCityId) {
    syncSelfHostedRegistration(frontendCityId);
    lastRegisteredCityId = frontendCityId;
  }

  const loose = useSettingsStore.getState().poiIncludeLooseTier;
  const mode = resolvePoiFetchMode(frontendCityId);
  if (
    !force &&
    frontendCityId === lastCityId &&
    loose === lastLoose &&
    mode === lastMode
  ) {
    return null;
  }
  lastCityId = frontendCityId;
  lastLoose = loose;
  lastMode = mode;

  // Below the no-op guard above (unlike the registration prologue): only
  // re-check the address-search manifest when this call is actually doing
  // something, not on every POI-sync trigger — the previous unconditional
  // placement fired a fresh manifest fetch even on calls that otherwise
  // returned null as a total no-op.
  void syncAddressSearch(frontendCityId);

  // augmentEligible: kill-switch ON AND geocoder present AND a LOCAL mode → augmentation is armed
  // (the visible "this city augments, not residency-pure" signal). False under server-side (mode is
  // not local), when no geocoder resolves, OR when ADDR_AUG_ENABLED is off. MUST mirror the runtime
  // arming conjunction over the SAME hasServerSideGeocoder read so the breadcrumb and the
  // gate agree for a city (AC-A26 / the same-capability invariant).
  const augmentEligible =
    ADDR_AUG_ENABLED &&
    hasServerSideGeocoder(frontendCityId) &&
    (mode === "eager-bundle" || mode === "lazy-tile");
  console.info("[poiSync] resolved", {
    cityId: frontendCityId,
    resolvedVia: resolutionSource(frontendCityId),
    mode,
    augmentEligible,
  });

  return syncPoiForCity(frontendCityId, {
    loadBundle: async (cityId) => { await loadPoiBundle(cityId, { includeLooseTier: loose, retainLooseCache: true }); },
    makeTileLoader: (opts) => {
      const tiling = getActiveCityPoiTiling(
        opts.cityId,
        opts.bundleSha256,
      );
      if (!tiling) {
        throw new Error(`missing active POI tile generation for ${opts.cityId}`);
      }
      const loader = createTileLoader({
        ...opts,
        generationId: tiling.generationId,
        onGenerationMismatch: forcePoiResync,
      });
      registerActiveTileLoader(opts.cityId, loader);
      scheduleIdle(() => {
        const c = useCityStore.getState().activeCity;
        void loader.loadViewport({
          minLat: c.bbox.minLat, maxLat: c.bbox.maxLat, minLon: c.bbox.minLon, maxLon: c.bbox.maxLon,
        });
      });
      return loader;
    },
    resolveMode: resolvePoiFetchMode,
    getTiling: getCityPoiTiling,
    poiCityIds,
    getActiveCityId: () => useCityStore.getState().activeCity.id,
    includeLooseTier: loose,
    disposePrior: disposeActiveTileLoaders,
    // Observability ONLY: confirms the RESOLVED mode === "server-side" actually suppressed the
    // corpus fetch. Keyed on the resolved mode (syncPoiForCity drives this off resolveMode), NOT on
    // geocoder presence — under augmentation the mode is LOCAL, the corpus is wanted, and
    // suppression must NOT fire. NEVER mutates a table. purgeCorpus stays unwired (residency holds
    // without it).
    onServerSide: (cityId) => {
      console.info("[poiSync] server-side: corpus fetch suppressed", { cityId });
    },
  });
}

function reportPoiSyncError(err: unknown): void {
  const frontendCityId = useCityStore.getState().activeCity.id;
  reportError(err instanceof Error ? err : new Error(String(err)), {
    context: { source: "syncPoi", frontendCityId },
  });
}

export function syncPoi(): void {
  const work = runPoiSync(false);
  if (work) void work.catch(reportPoiSyncError);
}

/** Recover from a server-rejected generation even when city/settings/mode are
 * unchanged. Concurrent 409s share one orchestrator run. */
export function forcePoiResync(): void {
  if (forcedResync) return;
  const work = runPoiSync(true) ?? Promise.resolve();
  const tracked = work
    .catch(reportPoiSyncError)
    .finally(() => {
      if (forcedResync === tracked) forcedResync = null;
    });
  forcedResync = tracked;
}

/** Test-only reset of the module-scoped guards so each `it` starts fresh. */
export function __resetBootPoiForTests(): void {
  lastCityId = null;
  lastLoose = null;
  lastMode = null;
  lastRegisteredCityId = null;
  forcedResync = null;
}
