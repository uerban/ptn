import { describe, expect, it } from "vitest";
import type { SearchSuggestion } from "./searchSuggestions.ts";
import { searchResultSubtext } from "./searchResultSubtext.ts";

function poi(overrides: Partial<Extract<SearchSuggestion, { kind: "geocoded" }>> = {}): SearchSuggestion {
  return { kind: "geocoded", label: "გალერია თბილისი", lat: 41.69, lon: 44.8,
    confidence: 1, category: "retail", source: "osm", poiIdentity: "mall", score: 1, ...overrides };
}

describe("search result subtext", () => {
  it("prefers an authored app-language alternate and preserves the native title", () => {
    const suggestion = poi({ aliases: { en: ["Galleria Tbilisi"], "ka-Latn": ["Galeria Tbilisi"] } });
    expect(searchResultSubtext(suggestion, "en")).toBe("Galleria Tbilisi");
    expect(suggestion).toHaveProperty("label", "გალერია თბილისი");
  });
  it("prefers the exact locale before the base language regardless of tag order", () => {
    expect(searchResultSubtext(poi({ aliases: { en: ["Base name"], "en-GB": ["Regional name"] } }), "en-GB"))
      .toBe("Regional name");
  });
  it("uses mapped romanization before an English fallback", () => {
    expect(searchResultSubtext(poi({ aliases: { "ka-Latn": ["Galeria Tbilisi"], en: ["Tbilisi Gallery"] } }), "pl"))
      .toBe("Galeria Tbilisi");
  });
  it("romanizes Georgian when no distinct mapped alternate exists", () => {
    expect(searchResultSubtext(poi({ label: "ვარკეთილი", aliases: { en: ["ვარკეთილი"] } }), "en")).toBe("vark’etili");
    expect(searchResultSubtext(poi({ label: "რუსთაველი" }), "en")).toBe("rustaveli");
    expect(searchResultSubtext(poi({ label: "ᲠᲣᲡᲗᲐᲕᲔᲚᲘ" }), "en")).toBe("rustaveli");
  });
  it("does not invent transliterations for unsupported scripts", () => {
    expect(searchResultSubtext(poi({ label: "東京" }), "en")).toBeUndefined();
    expect(searchResultSubtext(poi({ label: "თბილისი 東京" }), "en")).toBeUndefined();
  });
  it("combines an alternate with mapped street and locality", () => {
    expect(searchResultSubtext(poi({ aliases: { en: ["Galleria Tbilisi"] }, address: {
      street: "Rustaveli Ave", houseNumber: "2/4", locality: "Mtatsminda",
    } }), "en")).toBe("Galleria Tbilisi · Rustaveli Ave 2/4 · Mtatsminda");
  });
  it("omits duplicates and standalone house numbers", () => {
    expect(searchResultSubtext(poi({ label: "Library", aliases: { en: [" LIBRARY "] },
      address: { houseNumber: "4", locality: "library" } }), "en")).toBeUndefined();
    expect(searchResultSubtext(poi({ label: "Library", address: { locality: "Vilnius" } }), "en")).toBe("Vilnius");
  });
  it("does not choose unrelated languages or strip Latin diacritics", () => {
    expect(searchResultSubtext(poi({ label: "Gdańsk", aliases: { de: ["Danzig"] } }), "en")).toBeUndefined();
    expect(searchResultSubtext(poi({ label: "Warszawa", aliases: { en: ["Warsaw"] } }), "en-GB")).toBe("Warsaw");
  });
  it("also supplies Georgian display fallback for stops and groups", () => {
    expect(searchResultSubtext({ kind: "stop", stopId: "1", name: "რუსთაველი", lat: 0, lon: 0, score: 1 }, "en"))
      .toBe("rustaveli");
    expect(searchResultSubtext({ kind: "stopGroup", groupId: "1", name: "ვარკეთილი", lat: 0, lon: 0,
      score: 1, stopCount: 2, stopIds: ["1", "2"] }, "en")).toBe("vark’etili");
  });
});
