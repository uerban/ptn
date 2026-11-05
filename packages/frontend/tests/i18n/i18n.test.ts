import { describe, it, expect } from "vitest";
import {
  detectLanguage,
  type SupportedLocale,
  SUPPORTED_LOCALES,
} from "../../src/i18n/index.ts";
import { pluralize } from "../../src/i18n/plurals.ts";
import en from "../../src/i18n/locales/en.json";
import lt from "../../src/i18n/locales/lt.json";
import pl from "../../src/i18n/locales/pl.json";
import be from "../../src/i18n/locales/be.json";
import ru from "../../src/i18n/locales/ru.json";
import uk from "../../src/i18n/locales/uk.json";
import lv from "../../src/i18n/locales/lv.json";
import et from "../../src/i18n/locales/et.json";
import sv from "../../src/i18n/locales/sv.json";
import nb from "../../src/i18n/locales/nb.json";
import fi from "../../src/i18n/locales/fi.json";

const LOCALE_FILES: Record<SupportedLocale, Record<string, string>> = {
  en,
  lt,
  pl,
  be,
  ru,
  uk,
  lv,
  et,
  sv,
  nb,
  fi,
};

describe("detectLanguage", () => {
  it("returns matching language for exact code", () => {
    expect(detectLanguage("lt")).toBe("lt");
    expect(detectLanguage("en")).toBe("en");
  });

  it("extracts primary subtag from locale", () => {
    expect(detectLanguage("lt-LT")).toBe("lt");
    expect(detectLanguage("en-US")).toBe("en");
    expect(detectLanguage("ru-RU")).toBe("ru");
  });

  it("falls back to en for unsupported language", () => {
    expect(detectLanguage("ja")).toBe("en");
    expect(detectLanguage("fr-FR")).toBe("en");
  });

  it("maps every Norwegian tag a browser reports onto the Bokmål bundle", () => {
    // "no" and "nn" are not locale codes PTN ships, but a Norwegian speaker
    // reading Bokmål is far better served than one dropped into English.
    expect(detectLanguage("nb-NO")).toBe("nb");
    expect(detectLanguage("no")).toBe("nb");
    expect(detectLanguage("nn-NO")).toBe("nb");
  });
});

describe("SUPPORTED_LOCALES", () => {
  it("includes all 11 languages", () => {
    const expected: SupportedLocale[] = [
      "en", "lt", "pl", "be", "ru", "uk", "lv", "et", "sv", "nb", "fi",
    ];
    expect(SUPPORTED_LOCALES).toEqual(expected);
  });
});

describe("tz.* indicator keys", () => {
  // Every tz indicator string must exist in EVERY locale, including `pl`
  // (Krakow + Tricity, Europe/Warsaw) — the cities most likely to surface the
  // cross-tz badge, so a missing key there would silently fall back to English.
  const TZ_KEYS = [
    "tz.city_time",
    "tz.unverified",
    "tz.device_time",
    "tz.city_time_hint",
    "tz.unverified_hint",
    "tz.device_time_hint",
  ] as const;

  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale} defines every tz.* key with a non-empty value`, () => {
      const file = LOCALE_FILES[locale];
      for (const key of TZ_KEYS) {
        expect(file[key], `${locale} missing ${key}`).toBeTypeOf("string");
        expect(file[key]?.length ?? 0, `${locale} empty ${key}`).toBeGreaterThan(0);
      }
    });
  }

  it("the {tz}-substitution keys keep the {tz} placeholder in every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const file = LOCALE_FILES[locale];
      expect(file["tz.city_time"], `${locale} tz.city_time placeholder`).toContain("{tz}");
      expect(file["tz.unverified"], `${locale} tz.unverified placeholder`).toContain("{tz}");
    }
  });
});

describe("pluralize", () => {
  it("handles English plurals", () => {
    expect(pluralize("en", 1, "transfer", "transfers")).toBe("transfer");
    expect(pluralize("en", 0, "transfer", "transfers")).toBe("transfers");
    expect(pluralize("en", 5, "transfer", "transfers")).toBe("transfers");
  });

  it("handles Slavic plurals (Russian)", () => {
    expect(pluralize("ru", 1, "пересадка", "пересадки", "пересадок")).toBe("пересадка");
    expect(pluralize("ru", 2, "пересадка", "пересадки", "пересадок")).toBe("пересадки");
    expect(pluralize("ru", 5, "пересадка", "пересадки", "пересадок")).toBe("пересадок");
    expect(pluralize("ru", 21, "пересадка", "пересадки", "пересадок")).toBe("пересадка");
    expect(pluralize("ru", 11, "пересадка", "пересадки", "пересадок")).toBe("пересадок");
  });

  it("handles Latvian plurals (the zero form covers 0 and the teens)", () => {
    expect(pluralize("lv", 1, "pietura", "pieturas", "pieturu")).toBe("pietura");
    expect(pluralize("lv", 21, "pietura", "pieturas", "pieturu")).toBe("pietura");
    expect(pluralize("lv", 2, "pietura", "pieturas", "pieturu")).toBe("pieturas");
    expect(pluralize("lv", 0, "pietura", "pieturas", "pieturu")).toBe("pieturu");
    expect(pluralize("lv", 11, "pietura", "pieturas", "pieturu")).toBe("pieturu");
    expect(pluralize("lv", 20, "pietura", "pieturas", "pieturu")).toBe("pieturu");
  });

  it("handles the one/other languages", () => {
    for (const locale of ["et", "sv", "nb", "fi"]) {
      expect(pluralize(locale, 1, "stop", "stops")).toBe("stop");
      expect(pluralize(locale, 0, "stop", "stops")).toBe("stops");
      expect(pluralize(locale, 7, "stop", "stops")).toBe("stops");
    }
  });

  it("handles Lithuanian plurals", () => {
    expect(pluralize("lt", 1, "persėdimas", "persėdimai", "persėdimų")).toBe("persėdimas");
    expect(pluralize("lt", 2, "persėdimas", "persėdimai", "persėdimų")).toBe("persėdimai");
    expect(pluralize("lt", 10, "persėdimas", "persėdimai", "persėdimų")).toBe("persėdimų");
    expect(pluralize("lt", 11, "persėdimas", "persėdimai", "persėdimų")).toBe("persėdimų");
    expect(pluralize("lt", 21, "persėdimas", "persėdimai", "persėdimų")).toBe("persėdimas");
  });
});
