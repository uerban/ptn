import { describe, it, expect } from "vitest";
import {
  LAZY_LOCALE_CODES,
  precacheGlobIgnores,
  sampleAssetFor,
} from "./precache.js";
import { runtimeCaching } from "./runtimeCaching.js";

const firstMatch = (url: string) =>
  runtimeCaching.find((rule) => rule.urlPattern.test(url));

describe("precache exclusions", () => {
  it("excludes every locale except English", () => {
    expect([...LAZY_LOCALE_CODES]).toEqual([
      "lt", "pl", "be", "ru", "uk", "lv", "et", "sv", "nb", "fi",
    ]);
    expect(precacheGlobIgnores.some((g) => g.includes("/en-"))).toBe(false);
  });

  // The whole point of un-precaching is that the asset is still reachable
  // offline once it has been used. A glob with no runtime rule behind it is
  // an asset that simply breaks in a tunnel.
  it("has a runtime cache rule behind every excluded glob", () => {
    for (const glob of precacheGlobIgnores) {
      const url = `/${sampleAssetFor(glob)}`;
      const rule = firstMatch(url);
      expect(rule, `no runtime rule matches ${url} (from ${glob})`).toBeDefined();
      expect(rule?.handler, `${url} must retain an offline copy`).toBe(
        glob === "deployment-config.js" ? "NetworkFirst" : "CacheFirst",
      );
    }
  });

  it("does not divert the entry, vendor or route chunks", () => {
    for (const url of [
      "/assets/index-B2qAAsLg.js",
      "/assets/vendor-react-C2YWDahm.js",
      "/assets/vendor-map-BkggAV4a.js",
      "/assets/en-B2ItfdFG.js",
      "/assets/LinePreview-Cbx264eA.js",
      "/assets/badgeActivityStore-Dv7Iv4x_.js",
      "/assets/buildLinePatterns-BFwg3Q2R.js",
    ]) {
      expect(firstMatch(url), `${url} must not be diverted`).toBeUndefined();
    }
  });

  it("routes each lazy locale chunk to the offline cache", () => {
    for (const code of LAZY_LOCALE_CODES) {
      const rule = firstMatch(`/assets/${code}-Ki39EW2P.js`);
      expect(rule?.handler, `${code} chunk`).toBe("CacheFirst");
    }
  });

  it("routes the privacy namespace chunks to the offline cache", () => {
    expect(firstMatch("/assets/privacy-DnirjiGt.js")?.handler).toBe(
      "CacheFirst",
    );
    expect(firstMatch("/assets/privacy.uk-BNtQ63vY.js")?.handler).toBe(
      "CacheFirst",
    );
  });
});
