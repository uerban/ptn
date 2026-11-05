import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Guards the plural-key shape the app actually consumes.
//
// `pluralize()` (src/i18n/plurals.ts) selects between three forms — one / few /
// many. A key group offering only `_one` and `_other` therefore cannot render
// correctly in any locale with a richer plural rule than English: ru/be/uk/pl
// all need a distinct 2-4 form, so "5 велосипед" or "2 велосипедов" ships.
// That is exactly the bug these tests exist to stop coming back.

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = resolve(HERE, "../../src/i18n/locales");
const MANIFEST = resolve(HERE, "../../i18n-untranslated.json");

/** Locales whose plural rule needs more than the English one/other split. */
const MULTI_FORM_LOCALES = ["ru", "be", "uk", "pl", "lt", "lv"] as const;
/** Locales that split one/other exactly as English does. */
const ONE_OTHER_LOCALES = ["et", "sv", "nb", "fi"] as const;
const ALL_LOCALES = ["en", ...MULTI_FORM_LOCALES, ...ONE_OTHER_LOCALES] as const;

const readLocale = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(resolve(LOCALES, `${locale}.json`), "utf8"));

const untranslated: Record<string, string[]> = JSON.parse(
  readFileSync(MANIFEST, "utf8"),
);

const en = readLocale("en");
const pluralStems = Object.keys(en)
  .filter((k) => k.endsWith("_one"))
  .map((k) => k.slice(0, -"_one".length));

describe("plural key groups", () => {
  test("en.json declares at least one plural group", () => {
    // Guards the suite itself: a rename that silently emptied `pluralStems`
    // would make every test below vacuously pass.
    expect(pluralStems.length).toBeGreaterThan(0);
  });

  test.each(ALL_LOCALES)("%s uses _few/_many, never the English _other", (locale) => {
    const keys = new Set(Object.keys(readLocale(locale)));
    // `_other` only means a plural form when a `_one` sibling exists —
    // `settings.mode_other` is the transport mode "Other", not a count.
    const stale = [...keys].filter(
      (k) => k.endsWith("_other") && keys.has(`${k.slice(0, -"_other".length)}_one`),
    );
    expect(stale).toEqual([]);
  });

  test.each(ALL_LOCALES)("%s defines every form of every plural group", (locale) => {
    const strings = readLocale(locale);
    const declared = new Set(untranslated[locale] ?? []);

    const missing: string[] = [];
    for (const stem of pluralStems) {
      for (const form of ["_one", "_few", "_many"]) {
        const key = `${stem}${form}`;
        // A key absent because nobody has translated it yet is fine — the call
        // site's inline English fallback covers it. A key absent *and*
        // undeclared is the forgotten-key case the parity gate exists for.
        if (!(key in strings) && !declared.has(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });
});
