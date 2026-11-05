import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error - ESM script importer, no .d.mts shipped with it
import { checkParity } from "../../../../scripts/check-i18n-parity.mjs";

// Locale files used to carry a copy of the English string for every key a
// native speaker had not reached yet, because the gate demanded an identical
// keyset. That shipped ~6.6 kB gzipped of duplicated English which could
// never render: every t() call site passes an inline English fallback, so an
// absent key produces the same text for free.
//
// A key may now be absent from a locale, but only if it is declared in the
// untranslated manifest — so the gate still catches a key somebody simply
// forgot, which is the thing it exists to catch.

let dir: string;
const localesDir = () => join(dir, "locales");
const manifest = () => join(dir, "untranslated.json");

function writeLocales(files: Record<string, Record<string, string>>) {
  mkdirSync(localesDir(), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(
      join(localesDir(), `${name}.json`),
      JSON.stringify(body, null, 2) + "\n",
      "utf8",
    );
  }
}

function writeManifest(body: Record<string, string[]>) {
  writeFileSync(manifest(), JSON.stringify(body, null, 2) + "\n", "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ptn-i18n-untranslated-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkParity with an untranslated manifest", () => {
  it("accepts a key that is absent from a locale and declared untranslated", () => {
    writeLocales({
      en: { "a.one": "One", "a.two": "Two" },
      lt: { "a.one": "Vienas" },
    });
    writeManifest({ lt: ["a.two"] });
    expect(checkParity(localesDir(), manifest())).toEqual([]);
  });

  it("still reports a key that is absent and undeclared", () => {
    writeLocales({
      en: { "a.one": "One", "a.two": "Two" },
      lt: { "a.one": "Vienas" },
    });
    writeManifest({ lt: [] });
    const result = checkParity(localesDir(), manifest());
    expect(result).toHaveLength(1);
    expect(result[0].locale).toBe("lt");
    expect(result[0].missing).toEqual(["a.two"]);
  });

  it("reports a declaration whose key has since been translated", () => {
    writeLocales({
      en: { "a.one": "One" },
      lt: { "a.one": "Vienas" },
    });
    writeManifest({ lt: ["a.one"] });
    const result = checkParity(localesDir(), manifest());
    expect(result).toHaveLength(1);
    expect(result[0].staleUntranslated).toEqual(["a.one"]);
  });

  it("reports a declaration for a key that no longer exists in en.json", () => {
    writeLocales({
      en: { "a.one": "One" },
      lt: { "a.one": "Vienas" },
    });
    writeManifest({ lt: ["a.gone"] });
    const result = checkParity(localesDir(), manifest());
    expect(result).toHaveLength(1);
    expect(result[0].staleUntranslated).toEqual(["a.gone"]);
  });

  it("keeps working with no manifest at all — every key must be present", () => {
    writeLocales({
      en: { "a.one": "One", "a.two": "Two" },
      lt: { "a.one": "Vienas" },
    });
    const result = checkParity(localesDir());
    expect(result[0].missing).toEqual(["a.two"]);
  });
});

describe("markUntranslated", () => {
  it("declares every missing key and restores parity", async () => {
    // @ts-expect-error - ESM script importer, no .d.mts shipped with it
    const { markUntranslated } = await import(
      "../../../../scripts/check-i18n-parity.mjs"
    );
    const { readFileSync } = await import("node:fs");
    writeLocales({
      en: { "a.one": "One", "a.two": "Two", "a.three": "Three" },
      lt: { "a.one": "Vienas" },
    });
    writeManifest({ lt: ["a.two"] });

    markUntranslated(localesDir(), manifest());

    const written = JSON.parse(readFileSync(manifest(), "utf8"));
    // a.two was already declared; a.three is newly missing.
    expect(written.lt).toEqual(["a.three", "a.two"]);
    expect(checkParity(localesDir(), manifest())).toEqual([]);
  });
});

describe("the real locale files", () => {
  it("declare every absent key, and declare nothing stale", async () => {
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const frontend = resolve(here, "../..");
    expect(
      checkParity(
        resolve(frontend, "src/i18n/locales"),
        resolve(frontend, "i18n-untranslated.json"),
      ),
    ).toEqual([]);
  });

  it("ship no key whose value merely repeats the English string", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = resolve(here, "../../src/i18n/locales");
    const read = (n: string) =>
      JSON.parse(readFileSync(resolve(dir, `${n}.json`), "utf8")) as Record<
        string,
        string
      >;
    const en = read("en");
    for (const locale of [
      "lt", "pl", "be", "ru", "uk", "lv", "et", "sv", "nb", "fi",
    ]) {
      const dupes = Object.entries(read(locale))
        .filter(([k, v]) => en[k] === v)
        .map(([k]) => k);
      // Every t() call site passes an inline English fallback, so such a key
      // is bytes that can never change what the user reads. Declare it in
      // i18n-untranslated.json instead (--mark-untranslated).
      expect(dupes, `${locale} repeats English for these keys`).toEqual([]);
    }
  });
});
