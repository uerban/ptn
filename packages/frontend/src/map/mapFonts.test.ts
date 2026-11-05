import { describe, expect, test } from "vitest";

const sources = import.meta.glob<string>("../**/*.tsx", { query: "?raw", import: "default", eager: true });

describe("map label fonts", () => {
  // A symbol layer without text-font falls back to MapLibre's default stack,
  // a font the app does not use, and Carto has no Noto fallback in it.
  test("every symbol layer names its text-font", () => {
    const missing: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (file.includes(".test.")) continue;
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (!line.includes('type: "symbol"')) return;
        const layer = lines.slice(i, i + 20).join("\n");
        if (!layer.includes('"text-font"')) missing.push(`${file}:${i + 1}`);
      });
    }
    expect(missing).toEqual([]);
  });
});
