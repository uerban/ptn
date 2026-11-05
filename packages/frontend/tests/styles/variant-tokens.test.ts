import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The `:root` block in themes.css is the fallback for components that
 * render before `[data-variant]` is applied to `<html>`. Its values must
 * match `[data-variant="consumer"]` so the no-attribute state renders
 * identically to the runtime default. Without enforcement, a future
 * tweak to consumer tokens would silently drift the fallback.
 */
const THEMES_CSS_PATH = resolve(__dirname, "../../src/styles/themes.css");

function extractVariantTokens(blockSource: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const declRe = /(--variant-[a-z-]+)\s*:\s*([^;]+);/g;
  for (const match of blockSource.matchAll(declRe)) {
    tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

function extractAllBlocks(source: string, selector: string): string[] {
  // Multiple :root rules exist in themes.css (theme palette, overlay
  // opacity tokens, variant fallback). Return all of them so callers
  // can pick the one carrying the tokens they care about.
  const escaped = selector.replace(/[[\]"]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "gm");
  const blocks: string[] = [];
  for (const match of source.matchAll(re)) blocks.push(match[1]);
  if (blocks.length === 0) throw new Error(`Selector not found: ${selector}`);
  return blocks;
}

/**
 * Collect every --variant-* token across all blocks matching `selector`.
 * For `:root` this unions the variant-fallback block with whatever
 * other `:root` rules exist (palette, overlay opacities) — those define
 * different token namespaces, so the union is well-defined.
 */
function variantTokensFor(source: string, selector: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const block of extractAllBlocks(source, selector)) {
    for (const [k, v] of extractVariantTokens(block)) tokens.set(k, v);
  }
  return tokens;
}

describe("variant density tokens — :root must mirror [data-variant=\"consumer\"]", () => {
  const css = readFileSync(THEMES_CSS_PATH, "utf8");

  it("both blocks define exactly the same set of --variant-* tokens", () => {
    const root = variantTokensFor(css, ":root");
    const consumer = variantTokensFor(css, '[data-variant="consumer"]');

    expect([...root.keys()].sort()).toEqual([...consumer.keys()].sort());
  });

  it("each shared token has the same value in both blocks", () => {
    const root = variantTokensFor(css, ":root");
    const consumer = variantTokensFor(css, '[data-variant="consumer"]');

    for (const [key, consumerValue] of consumer) {
      expect(root.get(key)).toBe(consumerValue);
    }
  });

  it("the consumer block contains every --variant-* token (sanity: any added later)", () => {
    const consumer = variantTokensFor(css, '[data-variant="consumer"]');
    // Anchor against the known token set so adding a new one trips this
    // test and forces an update to both blocks together.
    const expected = [
      "--variant-row-pad",
      "--variant-row-min-height",
      "--variant-primary-text-size",
      "--variant-meta-text-size",
      "--variant-icon-size",
      "--variant-chip-gap",
      "--variant-row-separator",
    ].sort();
    expect([...consumer.keys()].sort()).toEqual(expected);
  });
});
