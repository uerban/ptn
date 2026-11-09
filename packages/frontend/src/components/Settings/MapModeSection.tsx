import {
  useSettingsStore,
  type MapDetailMode,
} from "../../stores/settingsStore.ts";
import {
  applyMapMode,
  effectiveMapMode,
  isDetailedMapLocked,
  MAP_MODE_ORDER,
} from "../../map/mapMode.ts";
import { useExternalBasemapAllowed } from "../../services/basemapPrivacy.ts";
import { BASEMAP_PROVIDERS } from "../../config/basemapProviders.ts";
import { useTranslation } from "../../i18n/index.ts";
import { MICROMAP_LAYERS, type MicromapLayer } from "../../map/micromap/types.ts";
import { useMicromapState } from "../../services/micromapLoader.ts";
import { useCityStore } from "../../stores/cityStore.ts";

const LAYER_FALLBACKS: Record<MicromapLayer, string> = {
  water: "lakes and the sea",
  green: "parks and forests",
  waterways: "rivers and canals",
  roads: "main roads",
  places: "district and place names",
};

/** "a, b and c" in the reader's language. */
function joinList(items: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}

/**
 * The single map-mode control.
 *
 * Selecting a mode writes the display setting; selecting the detailed map is
 * also the deliberate action that allows its provider (see `map/mapMode.ts`).
 * While the provider is not allowed, a detailed preference draws the micromap
 * and says so, with a way to allow it.
 */
export function MapModeSection() {
  const { t, formattingLocale } = useTranslation();
  const city = useCityStore((s) => s.activeCity);
  const micromapState = useMicromapState(city.id);
  const mapDetailMode = useSettingsStore((s) => s.mapDetailMode);
  const setMapDetailMode = useSettingsStore((s) => s.setMapDetailMode);
  const basemapAllowed = useExternalBasemapAllowed();
  const effectiveMode = effectiveMapMode(mapDetailMode, basemapAllowed);
  const detailedLocked = isDetailedMapLocked();

  const providerName = BASEMAP_PROVIDERS.carto.name;
  const micromapContents = joinList(
    MICROMAP_LAYERS.map((layer) => t(`settings.micromap_layer_${layer}`, LAYER_FALLBACKS[layer])),
    formattingLocale,
  );

  const OPTIONS: Record<MapDetailMode, { label: string; desc: string }> = {
    detailed: {
      label: t("settings.map_mode_detailed", "Detailed street map"),
      desc: t(
        "settings.map_mode_detailed_desc",
        "Street-level detail from {provider}. Your IP address and the map area you look at reach the provider.",
      ).replace("{provider}", providerName),
    },
    micromap: {
      label: t("settings.map_mode_micromap", "Minimal offline map"),
      desc: t(
        "settings.map_mode_micromap_desc",
        "Kept on this device and shows only {contents}. Side streets, buildings, addresses and points of interest are left out. Makes no map requests.",
      ).replace("{contents}", micromapContents),
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
    "privacy.map.detailedUnavailable",
    "The detailed map is not available in this version of the app.",
  );

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
              className={`flex items-start justify-between gap-3 px-4 py-3 min-h-11 border-b border-divider last:border-b-0 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
            >
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm text-fg">{option.label}</span>
                <span className="text-xs text-fg-muted">{option.desc}</span>
                {disabled && (
                  <span className="text-xs text-fg-muted italic">
                    {lockedCopy}
                  </span>
                )}
                {mode === "micromap" && micromapState === "absent" && (
                  <span className="text-xs text-fg-muted italic">
                    {t(
                      "settings.map_mode_micromap_absent",
                      "Not available for {city} yet, so transit route shapes are drawn instead.",
                    ).replace("{city}", city.name)}
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
                  applyMapMode(mode, { setMapDetailMode })
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
      {mapDetailMode === "detailed" && !basemapAllowed && !detailedLocked && (
        <div className="text-xs text-fg-muted mt-2 flex flex-col items-start gap-1">
          <p>
            {t(
              "privacy.map.detailedNotAllowed",
              "Detailed maps from {provider} are off, so the minimal offline map is drawn instead.",
            ).replace("{provider}", providerName)}
          </p>
          <button
            type="button"
            onClick={() => applyMapMode("detailed", { setMapDetailMode })}
            className="text-accent underline"
          >
            {t("privacy.map.allowDetailed", "Use detailed maps")}
          </button>
        </div>
      )}
    </section>
  );
}
