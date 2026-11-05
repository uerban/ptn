import { describe, expect, it } from "vitest";
import {
  addressSearchQueryVariants,
  buildAddressSearchKeys,
  normalizeAddressSearchText,
} from "./normalizer.js";

describe("local address search normalizer", () => {
  it("folds Lithuanian diacritics while preserving ASCII token order", () => {
    expect(normalizeAddressSearchText("Šeimyniškių g. 12")).toBe("seimyniskiu g 12");
  });

  it("transliterates Cyrillic query text", () => {
    expect(normalizeAddressSearchText("Кудирк")).toBe("kudirk");
  });

  it("expands Cyrillic place terms into Lithuanian address terms", () => {
    expect(addressSearchQueryVariants("площадь Кудирки")).toContain("aikste kudirk");
  });

  it("transliterates Arabic-script query text for best-effort matching", () => {
    expect(normalizeAddressSearchText("شارع الاستقلال")).toBe("shara alastqlal");
    expect(addressSearchQueryVariants("شارع الاستقلال")).toContain("gatve alastqlal");
  });

  it("builds lookup keys that let a name-first query hit one row", () => {
    const keys = buildAddressSearchKeys("V. Kudirkos aikštė 1");

    expect(keys).toContain("v kudirkos aikste 1");
    expect(keys).toContain("kudirkos aikste 1");
    expect(keys).toContain("kudirk aikste 1");
  });

  it("does NOT store a term-first alias per row", () => {
    // The build-time alias cost 126,317 keys / 1.71 MB of FST on the vilnius
    // corpus (26% of keys, 39% of bytes) because each one started at a
    // canonical term and re-ordered the whole name, sharing almost no prefix.
    // Term-first word order is a QUERY concern now — see the rotation test.
    const keys = buildAddressSearchKeys("V. Kudirkos aikštė 1");

    expect(keys).not.toContain("aikste kudirk 1");
    expect(keys).not.toContain("aikste kudirkos 1");
  });

  it("rotates a leading address term so Slavic word order reaches term-last keys", () => {
    // `площадь Кудирки` / `улица Гедимино` put the generic term first; the
    // Lithuanian labels in the corpus put it last. The rotated variant is what
    // bridges the two, and it must survive stemming so a wrong case ending
    // still lands.
    const variants = addressSearchQueryVariants("площадь Кудирки");

    expect(variants).toContain("aikste kudirk");
    expect(variants).toContain("kudirk aikste");

    const keys = buildAddressSearchKeys("V. Kudirkos aikštė 1");
    expect(
      variants.some((variant) => keys.some((key) => key.startsWith(variant))),
    ).toBe(true);
  });

  it("rotates the term in front of the house number, not after it", () => {
    // `проспект Гедимино 23` must reach the stored key `gedimino prospektas 23`.
    // Appending the term to the very end yields `gedimino 23 prospektas`, which
    // prefix-matches nothing — every numbered term-first query returns empty.
    const variants = addressSearchQueryVariants("проспект Гедимино 23");

    expect(variants).toContain("gedimino prospektas 23");
    expect(variants).not.toContain("gedimino 23 prospektas");
  });

  it("leaves a term-last query untouched by rotation", () => {
    expect(addressSearchQueryVariants("Kudirkos aikštė")).toContain("kudirkos aikste");
    expect(addressSearchQueryVariants("Kudirkos aikštė")).not.toContain("aikste kudirkos");
  });

  it("does not display normalized keys as labels", () => {
    const keys = buildAddressSearchKeys("Šeimyniškių g. 12");

    expect(keys).toContain("seimyniskiu gatve 12");
    expect(keys).not.toContain("Šeimyniškių g. 12");
  });
});
