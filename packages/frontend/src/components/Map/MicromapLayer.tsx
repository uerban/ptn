import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { useCityStore } from "../../stores/cityStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useEffectiveMapMode } from "../../map/mapMode.ts";
import { labelFontstack } from "../../map/styleBuilder.ts";
import { loadMicromap } from "../../services/micromapLoader.ts";
import {
  EMPTY_MICROMAP_GEOJSON,
  micromapToGeoJson,
  type MicromapGeoJson,
} from "../../map/micromap/micromapGeoJson.ts";
import { GTFS_CORRIDOR_LAYER } from "./gtfsCorridors.ts";
import { BIKE_CIRCLE_LAYER, BIKE_LABEL_LAYER } from "./bikeShareFeatures.ts";

interface MicromapLayerProps {
  map: maplibregl.Map | null;
}

export const MICROMAP_SOURCES = {
  areas: "micromap-areas-source",
  waterways: "micromap-waterways-source",
  roads: "micromap-roads-source",
  places: "micromap-places-source",
} as const;

export const MICROMAP_LAYERS = {
  areas: "micromap-areas-fill",
  waterways: "micromap-waterways-line",
  roads: "micromap-roads-line",
  places: "micromap-places-label",
} as const;

// Draw order, bottom first. Areas underlie the lines they contain; labels sit
// above everything the micromap draws but still below stops and corridors.
const LAYER_ORDER = [
  MICROMAP_LAYERS.areas,
  MICROMAP_LAYERS.waterways,
  MICROMAP_LAYERS.roads,
  MICROMAP_LAYERS.places,
] as const;

/**
 * Muted on purpose. The micromap is context, not content: at a glance the eye
 * should still land on stops, corridors and the route overlay, with water and
 * roads reading as background texture.
 */
const PALETTE = {
  light: {
    water: "#c3d7e8",
    green: "#d3e3cd",
    waterway: "#a8c4dc",
    road: "#d8d3ca",
    roadCasing: "#c2bcb1",
    label: "#5c6470",
    labelHalo: "#f9fafb",
  },
  dark: {
    water: "#20303f",
    green: "#22321f",
    waterway: "#2c465c",
    road: "#39413c",
    roadCasing: "#2a312d",
    label: "#94a3b8",
    labelHalo: "#111827",
  },
} as const;

const AREA_COLOR = (
  theme: "light" | "dark",
): maplibregl.ExpressionSpecification => [
  "match",
  ["get", "kind"],
  "water",
  PALETTE[theme].water,
  "green",
  PALETTE[theme].green,
  PALETTE[theme].green,
];

// Class-scaled widths: a motorway stays visible when zoomed out, a secondary
// only earns pixels once the user is looking at a district.
const ROAD_WIDTH: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  8,
  [
    "match",
    ["get", "cls"],
    "motorway",
    1.1,
    "trunk",
    0.9,
    "primary",
    0.6,
    0.3,
  ],
  12,
  [
    "match",
    ["get", "cls"],
    "motorway",
    2.4,
    "trunk",
    2,
    "primary",
    1.5,
    1,
  ],
  16,
  [
    "match",
    ["get", "cls"],
    "motorway",
    6,
    "trunk",
    5,
    "primary",
    4,
    2.6,
  ],
];

const WATERWAY_WIDTH: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  8,
  ["match", ["get", "cls"], "river", 0.8, "canal", 0.6, 0.3],
  12,
  ["match", ["get", "cls"], "river", 2, "canal", 1.4, 0.7],
  16,
  ["match", ["get", "cls"], "river", 5, "canal", 3.5, 1.6],
];

const PLACE_TEXT_SIZE: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  9,
  ["match", ["get", "rank"], 1, 13, 2, 11, 9],
  14,
  ["match", ["get", "rank"], 1, 18, 2, 15, 13],
];

// Labels earn their place at different zooms. Ranks 3-4 (suburbs,
// neighbourhoods) are only useful once the viewport is district-sized —
// showing them at z9 turns the map into a word cloud. Ranks 1-2 (the city and
// its towns) are the opposite: useful while zoomed out, pure noise stamped
// across the middle of the screen once you are already looking at the city
// (caught in the staging screenshots — "Vilnius" sat on the old town at z13).
const PLACE_FILTER: maplibregl.ExpressionSpecification = [
  "any",
  ["all", ["<=", ["get", "rank"], 2], ["<", ["zoom"], 12]],
  ["all", [">=", ["get", "rank"], 3], [">=", ["zoom"], 11]],
];

/** The first layer the micromap must stay underneath. */
function findMicromapBeforeId(map: maplibregl.Map): string | undefined {
  try {
    const layers = map.getStyle().layers ?? [];
    const anchors = new Set<string>([
      GTFS_CORRIDOR_LAYER,
      BIKE_CIRCLE_LAYER,
      BIKE_LABEL_LAYER,
      "stops-clusters",
      "line-route-line",
    ]);
    return layers.find(
      (layer) =>
        anchors.has(layer.id) ||
        layer.id.startsWith("guidance-leg-") ||
        layer.id.startsWith("stops-"),
    )?.id;
  } catch {
    return undefined;
  }
}

function removeMicromap(map: maplibregl.Map): void {
  try {
    if (!map.getStyle()) return;
    for (const layer of LAYER_ORDER) {
      if (map.getLayer(layer)) map.removeLayer(layer);
    }
    for (const source of Object.values(MICROMAP_SOURCES)) {
      if (map.getSource(source)) map.removeSource(source);
    }
  } catch {
    // MapLibre can unset style internals during teardown; cleanup is best-effort.
  }
}

function upsertSource(
  map: maplibregl.Map,
  id: string,
  data: GeoJSON.FeatureCollection,
): void {
  const existing = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (existing) existing.setData(data);
  else map.addSource(id, { type: "geojson", data });
}

function hasGlyphs(map: maplibregl.Map): boolean {
  try {
    return typeof map.getStyle().glyphs === "string";
  } catch {
    return false;
  }
}

function upsertMicromap(
  map: maplibregl.Map,
  data: MicromapGeoJson,
  theme: "light" | "dark",
): void {
  let styleLoaded: boolean;
  try {
    styleLoaded = map.isStyleLoaded() === true;
  } catch {
    return;
  }
  if (!styleLoaded) return;

  try {
    upsertSource(map, MICROMAP_SOURCES.areas, data.areas);
    upsertSource(map, MICROMAP_SOURCES.waterways, data.waterways);
    upsertSource(map, MICROMAP_SOURCES.roads, data.roads);
    upsertSource(map, MICROMAP_SOURCES.places, data.places);

    const beforeId = findMicromapBeforeId(map);
    const palette = PALETTE[theme];

    if (!map.getLayer(MICROMAP_LAYERS.areas)) {
      map.addLayer(
        {
          id: MICROMAP_LAYERS.areas,
          type: "fill",
          source: MICROMAP_SOURCES.areas,
          paint: {
            "fill-color": AREA_COLOR(theme),
            "fill-opacity": 0.85,
          },
        },
        beforeId,
      );
    } else {
      map.setPaintProperty(MICROMAP_LAYERS.areas, "fill-color", AREA_COLOR(theme));
    }

    if (!map.getLayer(MICROMAP_LAYERS.waterways)) {
      map.addLayer(
        {
          id: MICROMAP_LAYERS.waterways,
          type: "line",
          source: MICROMAP_SOURCES.waterways,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": palette.waterway,
            "line-width": WATERWAY_WIDTH,
          },
        },
        beforeId,
      );
    } else {
      map.setPaintProperty(
        MICROMAP_LAYERS.waterways,
        "line-color",
        palette.waterway,
      );
    }

    if (!map.getLayer(MICROMAP_LAYERS.roads)) {
      map.addLayer(
        {
          id: MICROMAP_LAYERS.roads,
          type: "line",
          source: MICROMAP_SOURCES.roads,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": palette.road,
            "line-width": ROAD_WIDTH,
          },
        },
        beforeId,
      );
    } else {
      map.setPaintProperty(MICROMAP_LAYERS.roads, "line-color", palette.road);
    }

    // Labels need a glyph source. With VITE_MAP_LABELS_MODE=network there are
    // no local glyphs and no external style in this mode, so the micromap
    // stays label-less rather than throwing on every style reload.
    if (hasGlyphs(map)) {
      if (!map.getLayer(MICROMAP_LAYERS.places)) {
        map.addLayer(
          {
            id: MICROMAP_LAYERS.places,
            type: "symbol",
            source: MICROMAP_SOURCES.places,
            filter: PLACE_FILTER,
            layout: {
              "text-field": ["get", "name"],
              "text-font": [...labelFontstack()],
              "text-size": PLACE_TEXT_SIZE,
              "text-max-width": 8,
              "text-padding": 6,
              "symbol-sort-key": ["get", "rank"],
            },
            paint: {
              "text-color": palette.label,
              "text-halo-color": palette.labelHalo,
              "text-halo-width": 1.2,
            },
          },
          beforeId,
        );
      } else {
        map.setPaintProperty(
          MICROMAP_LAYERS.places,
          "text-color",
          palette.label,
        );
        map.setPaintProperty(
          MICROMAP_LAYERS.places,
          "text-halo-color",
          palette.labelHalo,
        );
      }
    }

    ensureMicromapOrder(map, beforeId);
  } catch {
    // A style swap mid-update leaves the layers to be re-added on the next
    // styledata event; never let a paint failure take the map down.
  }
}

function ensureMicromapOrder(
  map: maplibregl.Map,
  beforeId: string | undefined,
): void {
  if (!beforeId) return;
  try {
    if (!map.getLayer(beforeId)) return;
    for (const layer of LAYER_ORDER) {
      if (map.getLayer(layer)) map.moveLayer(layer, beforeId);
    }
  } catch {
    return;
  }
}

/**
 * Offline city micromap — water, green areas, rivers, major roads and district
 * labels, decoded from a ~40 KB artifact shipped with the app.
 *
 * Active whenever the effective map mode is `micromap` (see `map/mapMode.ts`),
 * which includes the case where the user asked for the detailed basemap but
 * their privacy level withholds it. Cities without an artifact render nothing
 * here and keep the GTFS corridors that every local mode draws.
 */
export function MicromapLayer({ map }: MicromapLayerProps) {
  const activeCityId = useCityStore((s) => s.activeCity.id);
  const enabled = useEffectiveMapMode() === "micromap";
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const [data, setData] = useState<MicromapGeoJson>(EMPTY_MICROMAP_GEOJSON);
  const dataRef = useRef<MicromapGeoJson>(EMPTY_MICROMAP_GEOJSON);
  const themeRef = useRef(theme);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    if (!enabled) {
      setData(EMPTY_MICROMAP_GEOJSON);
      return;
    }
    // No AbortController on purpose: the load is memoized per city and shared,
    // so cancelling it here would strand a concurrent (or StrictMode-remounted)
    // caller. Ignoring a late result is enough.
    let cancelled = false;
    void loadMicromap(activeCityId).then((artifact) => {
      if (cancelled) return;
      setData(artifact ? micromapToGeoJson(artifact) : EMPTY_MICROMAP_GEOJSON);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, activeCityId]);

  useEffect(() => {
    dataRef.current = data;
    if (!map) return;
    if (!enabled || data.areas.features.length + data.roads.features.length === 0) {
      removeMicromap(map);
      return;
    }
    upsertMicromap(map, data, theme);
  }, [map, enabled, data, theme]);

  // A style swap (theme flip, basemap install/removal) drops every layer we
  // added; re-apply on the events that follow one.
  useEffect(() => {
    if (!map || !enabled) return;
    const sync = () => {
      const current = dataRef.current;
      if (current.areas.features.length + current.roads.features.length === 0) {
        return;
      }
      upsertMicromap(map, current, themeRef.current);
    };
    map.on("styledata", sync);
    map.on("idle", sync);
    return () => {
      map.off("styledata", sync);
      map.off("idle", sync);
      removeMicromap(map);
    };
  }, [map, enabled]);

  return null;
}
