import type { SupportedLocale } from "./index.ts";

export function pluralize(
  locale: SupportedLocale | string,
  count: number,
  one: string,
  few: string,
  many?: string
): string {
  const abs = Math.abs(count);
  switch (locale) {
    case "en":
      return abs === 1 ? one : few;
    case "lt": {
      const mod10 = abs % 10;
      const mod100 = abs % 100;
      if (mod10 === 1 && mod100 !== 11) return one;
      if (mod10 === 0 || (mod100 >= 10 && mod100 <= 20)) return many ?? few;
      return few;
    }
    case "pl": {
      const mod10 = abs % 10;
      const mod100 = abs % 100;
      if (abs === 1) return one;
      if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
      return many ?? few;
    }
    // Latvian: CLDR gives it one / zero / other, where the "zero" form covers
    // n ending in 0 and the teens (0 pieturu, 11 pieturu, 20 pieturu). It maps
    // onto the `many` slot the same way Lithuanian's genitive plural does.
    case "lv": {
      const mod10 = abs % 10;
      const mod100 = abs % 100;
      if (mod10 === 1 && mod100 !== 11) return one;
      if (mod10 === 0 || (mod100 >= 11 && mod100 <= 19)) return many ?? few;
      return few;
    }
    // One/other languages: same shape as English, spelled out rather than
    // left to the default so adding a locale is a deliberate decision.
    case "et":
    case "sv":
    case "nb":
    case "fi":
      return abs === 1 ? one : few;
    case "ru":
    case "uk":
    case "be": {
      const mod10 = abs % 10;
      const mod100 = abs % 100;
      if (mod10 === 1 && mod100 !== 11) return one;
      if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
      return many ?? few;
    }
    default:
      return abs === 1 ? one : few;
  }
}
