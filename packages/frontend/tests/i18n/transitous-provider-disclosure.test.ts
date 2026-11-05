import { describe, expect, it } from "vitest";
import {
  loadLocale,
  loadPrivacyNamespace,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "../../src/i18n/index.ts";

const THIRD_PARTY_MARKERS: Record<SupportedLocale, string> = {
  en: "third-party",
  lt: "trečios",
  pl: "zewnętrzn",
  be: "старонь",
  ru: "сторонн",
  uk: "сторонн",
  lv: "trešās",
  et: "kolmanda",
  sv: "tredjepart",
  nb: "tredjepart",
  fi: "kolmannen",
};

describe("transitous standing-provider disclosure", () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale} names transitous and preserves the exact field-list slot`, async () => {
      // privacy.* is no longer merged into loadLocale — it is fetched on
      // demand by the Settings privacy sections. See i18n/index.ts.
      const translations = await loadPrivacyNamespace(locale);
      const disclosure =
        translations["privacy.disclosure.transitousProvider"];
      expect(disclosure).toContain("transitous");
      expect(disclosure).toContain("{fields}");
      expect(disclosure).toContain(THIRD_PARTY_MARKERS[locale]);
    });

    it(`${locale} has no obsolete per-request Try copy`, async () => {
      const translations = await loadLocale(locale);
      expect(translations).not.toHaveProperty("transitous.try");
      expect(translations).not.toHaveProperty(
        "transitous.disclosure",
      );
      expect(translations).not.toHaveProperty(
        "transitous.provider_disclosure",
      );
    });
  }
});
