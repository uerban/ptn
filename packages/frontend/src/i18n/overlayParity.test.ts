import { describe, expect, test } from "vitest";
import { SUPPORTED_LOCALES } from "./index.ts";

// The privacy, setup and presentation namespaces ship as one English file
// plus one overlay per locale. The repo-wide parity script only walks
// locales/, so these overlays get their own check: every locale carries
// exactly the English keys, and each translation keeps the same {placeholders}.

type Strings = Record<string, string>;

const files = import.meta.glob<Strings>(
  ["./privacy*.json", "./setup*.json", "./presentation*.json"],
  { eager: true, import: "default" },
);

const NAMESPACES = ["privacy", "setup", "presentation"] as const;

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const translated = SUPPORTED_LOCALES.filter((locale) => locale !== "en");

describe.each(NAMESPACES)("%s namespace overlays", (ns) => {
  const en = files[`./${ns}.json`];

  test("the English source exists", () => {
    expect(en).toBeDefined();
  });

  test.each(translated)("%s has every key and no extras", (locale) => {
    const overlay = files[`./${ns}.${locale}.json`];
    expect(overlay, `${ns}.${locale}.json`).toBeDefined();
    expect(Object.keys(overlay).sort()).toEqual(Object.keys(en).sort());
  });

  test.each(translated)("%s keeps every placeholder", (locale) => {
    const overlay = files[`./${ns}.${locale}.json`];
    const mismatched = Object.keys(en).filter(
      (key) =>
        typeof overlay[key] === "string" &&
        placeholders(overlay[key]).join() !== placeholders(en[key]).join(),
    );
    expect(mismatched).toEqual([]);
  });
});
