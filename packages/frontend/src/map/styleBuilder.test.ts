import { describe, expect, test } from "vitest";
import type { LayerSpecification } from "maplibre-gl";
import {
  buildLocalStyle,
  buildMergedCartoStyle,
  labelFontstack,
  localGlyphRequest,
  type CartoStyleJson,
} from "./styleBuilder.ts";

const ORIGIN = "https://ptn.example";

describe("stop label fonts", () => {
  // Carto serves an empty Georgian/Cyrillic/Greek range for "Open Sans
  // Regular" alone, so non-Latin stop names rendered as nothing but their
  // digits. A combined stack lets the glyph server fall back to Noto.
  test("falls back to Noto Sans for scripts Open Sans lacks", () => {
    expect(labelFontstack()).toEqual(["Open Sans Regular", "Noto Sans Regular"]);
  });

  // MapLibre rejects the whole style when the glyphs URL lacks either token.
  test("local glyphs URL keeps the tokens the style spec requires", () => {
    const glyphs = buildLocalStyle(false).glyphs!;
    expect(glyphs).toContain("{fontstack}");
    expect(glyphs).toContain("{range}");
  });

  // Only Open Sans is bundled; the combined stack name must still load it.
  test("any local fontstack loads the bundled Open Sans ranges", () => {
    const url = buildLocalStyle(false).glyphs!
      .replace("{fontstack}", labelFontstack().join(","))
      .replace("{range}", "0-255");
    expect(localGlyphRequest(url, ORIGIN)).toBe("/glyphs/Open Sans Regular/0-255.pbf");
    expect(localGlyphRequest(`${ORIGIN}/glyphs/Open%20Sans%20Regular%2CNoto%20Sans%20Regular/256-511.pbf`, ORIGIN))
      .toBe(`${ORIGIN}/glyphs/Open Sans Regular/256-511.pbf`);
  });

  test("remote glyph servers keep the combined stack", () => {
    const carto = "https://tiles.basemaps.cartocdn.com/v/1/fonts/Open Sans Regular,Noto Sans Regular/4096-4351.pbf";
    expect(localGlyphRequest(carto, ORIGIN)).toBe(carto);
    const other = "https://elsewhere.example/glyphs/Open Sans Regular,Noto Sans Regular/0-255.pbf";
    expect(localGlyphRequest(other, ORIGIN)).toBe(other);
  });
});

describe("basemap fonts", () => {
  const cartoLayer = (font: unknown): LayerSpecification =>
    ({ id: "place", type: "symbol", source: "carto", layout: { "text-font": font } }) as LayerSpecification;
  const fontsOf = (font: unknown) => {
    const carto = { version: 8, sources: {}, layers: [cartoLayer(font)] } as CartoStyleJson;
    const merged = buildMergedCartoStyle(carto, { id: "stops", definition: { type: "geojson", data: { type: "FeatureCollection", features: [] } } }, []);
    return (merged.layers[0] as { layout: Record<string, unknown> }).layout["text-font"];
  };

  // Carto mixes Montserrat, Open Sans, Noto and Noto CJK in every label. The
  // app uses Open Sans with Noto for other scripts, so the basemap does too.
  test("Carto label stacks keep only the app's families", () => {
    expect(fontsOf(["Montserrat SemiBold", "Open Sans Bold", "Noto Sans Regular", "Noto Sans CJK JP Regular"]))
      .toEqual(["Open Sans Bold", "Noto Sans Regular"]);
    expect(fontsOf(["Montserrat Regular Italic", "Open Sans Italic", "Noto Sans Regular", "Noto Sans CJK JP Regular"]))
      .toEqual(["Open Sans Italic", "Noto Sans Regular"]);
  });

  test("stacks without an app family are left alone", () => {
    expect(fontsOf(["Some Other Font"])).toEqual(["Some Other Font"]);
    const expr = ["step", ["zoom"], ["literal", ["A"]], 10, ["literal", ["B"]]];
    expect(fontsOf(expr)).toEqual(expr);
  });
});
