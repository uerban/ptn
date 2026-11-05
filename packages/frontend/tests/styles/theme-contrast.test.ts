import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// WCAG 2.1 contrast for the theme tokens used as text. Every text token must
// reach 4.5:1 (AA, normal text) on each surface; the status colours and the
// accent also on their own 10% tint, since the app pairs `text-warning` with
// `bg-warning/10` (status banners, delay chips, the selected profile button).
// https://www.w3.org/TR/WCAG21/#contrast-minimum

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styles/themes.css"),
  "utf8",
);

function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no block for ${selector}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2].toLowerCase()]),
  );
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `color` at `alpha` composited over `under`, as `bg-color/10` paints. */
const tint = (color: string, under: string, alpha = 0.1) =>
  "#" +
  rgb(color)
    .map((c, i) => Math.round(alpha * c + (1 - alpha) * rgb(under)[i]).toString(16).padStart(2, "0"))
    .join("");

const AA = 4.5;
const TEXT = ["fg", "fg-secondary", "fg-muted", "accent", "success", "warning", "danger"];
const TINTED = ["accent", "success", "warning", "danger"];

const LIGHT = block(':root, [data-theme="light"]');
const DARK = block('[data-theme="dark"]');
const SCHEMES = ["deuteranopia", "protanopia", "tritanopia", "monochrome", "universal"];

const themes: [string, Record<string, string>][] = [
  ["light", LIGHT],
  ["dark", DARK],
  ...SCHEMES.flatMap((s): [string, Record<string, string>][] => [
    [`light + ${s}`, { ...LIGHT, ...block(`[data-a11y-scheme="${s}"]`) }],
    [`dark + ${s}`, { ...DARK, ...block(`[data-theme="dark"][data-a11y-scheme="${s}"]`) }],
  ]),
];

describe("theme tokens meet WCAG AA contrast", () => {
  for (const [name, t] of themes) {
    const surfaces = [t.surface, t["surface-raised"], t["surface-overlay"]];

    it(`${name}: text tokens on every surface`, () => {
      const failures = TEXT.flatMap((tok) =>
        surfaces
          .filter((s) => contrast(t[tok], s) < AA)
          .map((s) => `${tok} ${t[tok]} on ${s}: ${contrast(t[tok], s).toFixed(2)}`),
      );
      expect(failures).toEqual([]);
    });

    it(`${name}: status colours and accent on their own tint`, () => {
      const failures = TINTED.flatMap((tok) =>
        surfaces
          .map((s) => tint(t[tok], s))
          .filter((bg) => contrast(t[tok], bg) < AA)
          .map((bg) => `${tok} ${t[tok]} on ${bg}: ${contrast(t[tok], bg).toFixed(2)}`),
      );
      expect(failures).toEqual([]);
    });

    it(`${name}: warning-fg on a warning fill`, () => {
      expect(contrast(t["warning-fg"], t.warning)).toBeGreaterThanOrEqual(AA);
    });
  }

  it("matches the ratio axe reported for the old light warning banner", () => {
    // axe-core: #ea580c on #fdeee7 = 3.14.
    expect(tint("#ea580c", "#ffffff")).toBe("#fdeee7");
    expect(contrast("#ea580c", "#fdeee7")).toBeCloseTo(3.14, 1);
  });
});
