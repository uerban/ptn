import type { StyleSpecification } from "maplibre-gl";
import maplibregl from "./maplibre.ts";
import {
  LOCAL_GLYPHS_FONT,
  LOCAL_GLYPHS_URL,
  LOCAL_LABEL_FONTSTACK,
  MAP_LABELS_MODE,
} from "./mapConfig.ts";

export const LOCAL_BG_LAYER_ID = "local-bg";

function readSurfaceOverlay(isDark: boolean): string {
  if (typeof window === "undefined") return isDark ? "#1f2937" : "#f9fafb";
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--surface-overlay")
    .trim();
  return v || (isDark ? "#1f2937" : "#f9fafb");
}

export function buildLocalStyle(isDark: boolean): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [
      {
        id: LOCAL_BG_LAYER_ID,
        type: "background",
        paint: { "background-color": readSurfaceOverlay(isDark) },
      },
    ],
  };
  if (MAP_LABELS_MODE === "inline") {
    style.glyphs = LOCAL_GLYPHS_URL;
  }
  return style;
}

export function labelFontstack(): readonly string[] {
  return LOCAL_LABEL_FONTSTACK;
}

const LOCAL_GLYPH_PATH = /^\/glyphs\/[^/]+\/(\d+-\d+\.pbf)$/;

/**
 * Point a same-origin glyph request at the bundled font. The label stack names
 * a fallback font that only remote glyph servers have, so without this every
 * local range would 404. Other URLs pass through unchanged.
 */
export function localGlyphRequest(url: string, origin: string): string {
  const path = url.startsWith(`${origin}/`) ? url.slice(origin.length) : url;
  const match = LOCAL_GLYPH_PATH.exec(path);
  if (!match) return url;
  return `${url.slice(0, url.length - path.length)}/glyphs/${LOCAL_GLYPHS_FONT}/${match[1]}`;
}

/**
 * Carto labels mix Montserrat, Open Sans, Noto Sans and Noto Sans CJK. The app
 * uses Open Sans with Noto Sans for other scripts, so a basemap stack keeps only
 * those. Carto lists an Open Sans weight in every stack, and serves any
 * combination of its fonts. Expressions and stacks with no app font pass
 * through.
 */
function isAppFont(font: string): boolean {
  return font.startsWith("Open Sans ") || font === "Noto Sans Regular";
}

function withAppFonts(layer: maplibregl.LayerSpecification): maplibregl.LayerSpecification {
  const layout = (layer as { layout?: Record<string, unknown> }).layout;
  const font = layout?.["text-font"];
  if (!Array.isArray(font) || !font.every((f) => typeof f === "string")) return layer;
  const kept = (font as string[]).filter(isAppFont);
  if (kept.length === 0 || kept.length === font.length) return layer;
  return { ...layer, layout: { ...layout, "text-font": kept } } as maplibregl.LayerSpecification;
}

export type CartoStyleJson = StyleSpecification & {
  sprite?: string | { id: string; url: string }[];
  glyphs?: string;
};

/**
 * Merge a fetched Carto style into a running map without tearing down the
 * existing style. Sources and layers are added incrementally; Carto layers
 * are inserted below `stopsBeforeId` so the stops layers stay on top.
 *
 * If `stopsBeforeId` is undefined (stops not yet on the map), Carto layers
 * are added on top — acceptable during the brief window before stops attach.
 */
export function mergeCartoIntoRunningMap(
  map: maplibregl.Map,
  cartoStyle: CartoStyleJson,
  stopsBeforeId: string | undefined,
): void {
  const sprite = cartoStyle.sprite;
  if (sprite) {
    // maplibre v5 accepts string or array-of-{id,url}; the typed signature
    // varies across minor versions, so cast at the boundary.
    (map as unknown as { setSprite: (s: typeof sprite) => void }).setSprite(sprite);
  }
  if (cartoStyle.glyphs) {
    map.setGlyphs(cartoStyle.glyphs);
  }

  if (cartoStyle.sources) {
    for (const [id, source] of Object.entries(cartoStyle.sources)) {
      if (map.getSource(id)) continue;
      map.addSource(id, source);
    }
  }

  const layers = (cartoStyle.layers ?? []).map(withAppFonts);
  for (const layer of layers) {
    if (map.getLayer(layer.id)) continue;
    if (stopsBeforeId && map.getLayer(stopsBeforeId)) {
      map.addLayer(layer, stopsBeforeId);
    } else {
      map.addLayer(layer);
    }
  }
}

/**
 * Build a style object for `setStyle` during a theme swap after Carto is
 * already loaded. The new Carto theme is merged with the current stops
 * source/layers so maplibre's style-diff preserves them — basemap layers
 * flip, stop dots stay put, no blink.
 */
export function buildMergedCartoStyle(
  cartoStyle: CartoStyleJson,
  stopsSource: { id: string; definition: maplibregl.SourceSpecification },
  stopsLayers: maplibregl.LayerSpecification[],
): StyleSpecification {
  return {
    ...cartoStyle,
    sources: {
      ...cartoStyle.sources,
      [stopsSource.id]: stopsSource.definition,
    },
    layers: [...(cartoStyle.layers ?? []).map(withAppFonts), ...stopsLayers],
  } as StyleSpecification;
}
