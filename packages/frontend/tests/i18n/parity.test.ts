import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
// @ts-expect-error - ESM script importer, no .d.mts shipped with it
import {
  checkParity,
  fixWithFallback,
  validateLocalesSyntax,
} from "../../../../scripts/check-i18n-parity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PASSING = resolve(HERE, "fixtures/parity-passing");
const FAILING = resolve(HERE, "fixtures/parity-failing");

describe("validateLocalesSyntax", () => {
  it("is exported as a function from the CLI script", () => {
    expect(typeof validateLocalesSyntax).toBe("function");
  });

  it("returns an empty array when every locale parses as valid JSON", () => {
    expect(validateLocalesSyntax(PASSING)).toEqual([]);
  });

  it("reports the locale and parse error for a file with a missing comma between keys", () => {
    // Reproduces the regression that broke the prod deploy build:
    // PR #173 (locale fill) + PR #175 (added rt.cancelled_warning) merged
    // into adjacent lines without a comma between them, so tsc emitted
    // an opaque TS1005 instead of pointing at the bad locale.
    const tmp = mkdtempSync(join(tmpdir(), "ptn-i18n-syntax-"));
    try {
      const localesDir = join(tmp, "locales");
      mkdirSync(localesDir, { recursive: true });
      writeFileSync(
        join(localesDir, "en.json"),
        JSON.stringify({ a: "1", b: "2" }, null, 2) + "\n",
        "utf8",
      );
      writeFileSync(
        join(localesDir, "be.json"),
        '{\n  "a": "1"\n  "b": "2"\n}\n',
        "utf8",
      );

      const result = validateLocalesSyntax(localesDir);
      expect(result).toHaveLength(1);
      expect(result[0].locale).toBe("be");
      expect(result[0].error).toMatch(/JSON/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags every broken locale (not just the first) so the preflight surfaces them all at once", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ptn-i18n-syntax-multi-"));
    try {
      const localesDir = join(tmp, "locales");
      mkdirSync(localesDir, { recursive: true });
      writeFileSync(
        join(localesDir, "en.json"),
        JSON.stringify({ a: "1" }, null, 2) + "\n",
        "utf8",
      );
      writeFileSync(join(localesDir, "be.json"), "{ not valid json", "utf8");
      writeFileSync(join(localesDir, "pl.json"), '{ "a": "1", }', "utf8");

      const result = validateLocalesSyntax(localesDir);
      expect(result.map((r) => r.locale).sort()).toEqual(["be", "pl"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("checkParity", () => {
  it("is exported as a function from the CLI script", () => {
    expect(typeof checkParity).toBe("function");
  });

  it("returns an empty array when every locale matches en.json (including nested keys)", () => {
    expect(checkParity(PASSING)).toEqual([]);
  });

  it("reports the missing key for a locale that lacks one of en's top-level keys", () => {
    expect(checkParity(FAILING)).toEqual([
      { locale: "be", missing: ["b"], extra: [] },
    ]);
  });

  it("reports extra keys for a locale that has keys absent from en.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ptn-i18n-extra-"));
    try {
      const localesDir = join(tmp, "locales");
      mkdirSync(localesDir, { recursive: true });
      writeFileSync(
        join(localesDir, "en.json"),
        JSON.stringify({ a: "1", b: "2" }, null, 2) + "\n",
        "utf8",
      );
      writeFileSync(
        join(localesDir, "be.json"),
        // typo'd 'bb' instead of 'b' — bidirectional check must flag both
        JSON.stringify({ a: "1-be", bb: "2-be" }, null, 2) + "\n",
        "utf8",
      );

      expect(checkParity(localesDir)).toEqual([
        { locale: "be", missing: ["b"], extra: ["bb"] },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports extras even when nothing is missing (stale key never removed)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ptn-i18n-stale-"));
    try {
      const localesDir = join(tmp, "locales");
      mkdirSync(localesDir, { recursive: true });
      writeFileSync(
        join(localesDir, "en.json"),
        JSON.stringify({ a: "1" }, null, 2) + "\n",
        "utf8",
      );
      writeFileSync(
        join(localesDir, "be.json"),
        JSON.stringify({ a: "1-be", legacy: "stale" }, null, 2) + "\n",
        "utf8",
      );

      expect(checkParity(localesDir)).toEqual([
        { locale: "be", missing: [], extra: ["legacy"] },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("fixWithFallback", () => {
  it("fills missing locale keys with EN values, restores parity, and writes a review-queue section", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ptn-i18n-fix-"));
    try {
      const localesDir = join(tmp, "locales");
      mkdirSync(localesDir, { recursive: true });
      writeFileSync(
        join(localesDir, "en.json"),
        JSON.stringify({ a: "1", b: "2", c: "with `tick`" }, null, 2) + "\n",
        "utf8",
      );
      writeFileSync(
        join(localesDir, "be.json"),
        JSON.stringify({ a: "1-be" }, null, 2) + "\n",
        "utf8",
      );
      const reviewPath = join(tmp, "i18n-review-queue.md");

      const fixed = new Date("2026-05-16T00:00:00Z");
      const result = fixWithFallback(localesDir, reviewPath, { now: fixed });
      expect(result).toEqual([{ locale: "be", missing: ["b", "c"], extra: [] }]);

      // Parity is restored after the fix.
      expect(checkParity(localesDir)).toEqual([]);

      // Locale file contains EN fallback values for the previously missing keys.
      const beAfter = JSON.parse(
        readFileSync(join(localesDir, "be.json"), "utf8"),
      );
      expect(beAfter).toEqual({ a: "1-be", b: "2", c: "with `tick`" });

      // Review queue: header block + per-locale section with date + escaped backticks.
      const review = readFileSync(reviewPath, "utf8");
      expect(review).toContain("# i18n Review Queue");
      expect(review).toContain("**Owner:** TBD");
      expect(review).toContain("### be.json (filled 2026-05-16)");
      expect(review).toContain("- [ ] `b` — `2`");
      expect(review).toContain("- [ ] `c` — `with \\`tick\\``");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not create the review-queue file when only extras are present (nothing to fill)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ptn-i18n-extras-only-"));
    try {
      const localesDir = join(tmp, "locales");
      mkdirSync(localesDir, { recursive: true });
      writeFileSync(
        join(localesDir, "en.json"),
        JSON.stringify({ a: "1" }, null, 2) + "\n",
        "utf8",
      );
      // be has an extra `legacy` key but no missing keys vs en.json.
      writeFileSync(
        join(localesDir, "be.json"),
        JSON.stringify({ a: "1-be", legacy: "stale" }, null, 2) + "\n",
        "utf8",
      );
      const reviewPath = join(tmp, "i18n-review-queue.md");

      fixWithFallback(localesDir, reviewPath, {
        now: new Date("2026-05-16T00:00:00Z"),
      });

      // Nothing was filled, so the contract "only fills missing keys"
      // means no empty header-only file should be created.
      expect(existsSync(reviewPath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves extras in place so a follow-up checkParity still reports the failure", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ptn-i18n-extras-after-fix-"));
    try {
      const localesDir = join(tmp, "locales");
      mkdirSync(localesDir, { recursive: true });
      writeFileSync(
        join(localesDir, "en.json"),
        JSON.stringify({ a: "1", b: "2" }, null, 2) + "\n",
        "utf8",
      );
      // be is missing `b` and carries a stale `legacy` key.
      writeFileSync(
        join(localesDir, "be.json"),
        JSON.stringify({ a: "1-be", legacy: "stale" }, null, 2) + "\n",
        "utf8",
      );
      const reviewPath = join(tmp, "i18n-review-queue.md");

      fixWithFallback(localesDir, reviewPath, {
        now: new Date("2026-05-16T00:00:00Z"),
      });

      // The fill closed the missing-key gap, but the stale extra remains —
      // the CLI relies on this to surface a non-zero exit after --fix-with-fallback.
      expect(checkParity(localesDir)).toEqual([
        { locale: "be", missing: [], extra: ["legacy"] },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
