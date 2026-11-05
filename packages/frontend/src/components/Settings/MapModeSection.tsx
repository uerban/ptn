import {
  usePrivacyStore,
  usePolicy,
} from "../../stores/privacyStore.ts";
import {
  useSettingsStore,
  type MapDetailMode,
} from "../../stores/settingsStore.ts";
import {
  applyMapMode,
  effectiveMapMode,
  isDetailedMapLocked,
  MAP_MODE_ORDER,
  maxLevelForDetailedMap,
} from "../../map/mapMode.ts";
import { BASEMAP_PROVIDERS } from "../../config/basemapProviders.ts";
import { useTranslation } from "../../i18n/index.ts";

/**
 * The single map-mode control.
 *
 * It replaces the pair that used to disagree with each other: the old Display →
 * "Map detail" radio and the privacy centre's "Detailed map" axis. Selecting a
 * mode here writes the display setting AND the `basemapMode` privacy override
 * (see `map/mapMode.ts`); the privacy preset still caps what is selectable, so
 * at Hardened and above the external option renders locked instead of being
 * silently ignored.
 */
export function MapModeSection() {
  const { t } = useTranslation();
  const mapDetailMode = useSettingsStore((s) => s.mapDetailMode);
  const setMapDetailMode = useSettingsStore((s) => s.setMapDetailMode);
  const level = usePrivacyStore((s) => s.level);
  const setOverride = usePrivacyStore((s) => s.setOverride);
  const clearOverride = usePrivacyStore((s) => s.clearOverride);
  const basemapMode = usePolicy().basemapMode;
  const effectiveMode = effectiveMapMode(mapDetailMode, basemapMode);
  const detailedLocked = isDetailedMapLocked(level);

  const providerName = BASEMAP_PROVIDERS.carto.name;

  const OPTIONS: Record<MapDetailMode, { label: string; desc: string }> = {
    detailed: {
      label: t("settings.map_mode_detailed", "Detailed street map"),
      desc: t(
        "settings.map_mode_detailed_desc",
        "Street-level detail from {provider}. Your IP address and the map area you look at reach the provider.",
      ).replace("{provider}", providerName),
    },
    micromap: {
      label: t("settings.map_mode_micromap", "Offline micromap"),
      desc: t(
        "settings.map_mode_micromap_desc",
        "A tiny city map kept on this device — water, major roads, green areas, district names. No map requests, works in a tunnel.",
      ),
    },
    "gtfs-only": {
      label: t("settings.map_mode_gtfs_only", "Transit corridors only"),
      desc: t(
        "settings.map_mode_gtfs_only_desc",
        "No basemap at all: only corridors drawn from GTFS shapes or stop sequences.",
      ),
    },
  };

  const lockedCopy = t(
    "settings.map_mode_locked",
    "Locked by the {level} preset. Lower your privacy level to {minLevel} to use the external map.",
  )
    .replace("{level}", level)
    .replace("{minLevel}", maxLevelForDetailedMap());

  return (
    <section id="settings-map-mode" aria-labelledby="settings-map-mode-heading">
      <h2
        id="settings-map-mode-heading"
        className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2"
      >
        {t("settings.map", "Map")}
      </h2>
      <p className="text-xs text-fg-secondary mb-2">
        {t(
          "settings.map_mode_desc",
          "What the map draws underneath stops and routes. Transit lines and stops are always local.",
        )}
      </p>
      <div
        role="radiogroup"
        aria-label={t("settings.map", "Map")}
        className="bg-surface-raised rounded-xl border border-divider"
      >
        {MAP_MODE_ORDER.map((mode) => {
          const disabled = mode === "detailed" && detailedLocked;
          const option = OPTIONS[mode];
          return (
            <label
              key={mode}
              className={`flex items-start justify-between gap-3 px-4 py-3 border-b border-divider last:border-b-0 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
            >
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm text-fg">{option.label}</span>
                <span className="text-xs text-fg-muted">{option.desc}</span>
                {disabled && (
                  <span className="text-xs text-fg-muted italic">
                    {lockedCopy}
                  </span>
                )}
              </span>
              <input
                type="radio"
                name="mapMode"
                value={mode}
                checked={mapDetailMode === mode}
                disabled={disabled}
                onChange={() =>
                  applyMapMode(mode, {
                    level,
                    setMapDetailMode,
                    setOverride,
                    clearOverride,
                  })
                }
                className="accent-accent mt-1"
              />
            </label>
          );
        })}
      </div>
      {effectiveMode === "micromap" && (
        <p className="text-xs text-fg-muted mt-2">
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {t(
              "settings.osm_attribution",
              "Map data \u00a9 OpenStreetMap contributors, ODbL",
            )}
          </a>
        </p>
      )}
      {mapDetailMode === "detailed" && basemapMode !== "external-detailed" && (
        <p className="text-xs text-fg-muted mt-2">
          {t(
            "settings.map_mode_demoted",
            "Your privacy level is withholding the external map, so the offline micromap is drawn instead.",
          )}
        </p>
      )}
    </section>
  );
}
