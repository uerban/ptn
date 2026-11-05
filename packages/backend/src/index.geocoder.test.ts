import { describe, expect, it } from "vitest";

import { resolveApiCityGeocoder } from "./index.js";

describe("resolveApiCityGeocoder", () => {
  it("maps ptn-fst to the per-city address-search route", () => {
    expect(resolveApiCityGeocoder({ id: "vilnius" }, { GEOCODER_FLAVOR: "ptn-fst" })).toEqual({
      kind: "self-hosted",
      endpoint: "/api/vilnius/address-search",
      flavor: "ptn-fst",
      multiTenant: true,
    });
  });

  it("keeps nominatim and photon on their reverse-proxy routes", () => {
    expect(resolveApiCityGeocoder({ id: "vilnius" }, { GEOCODER_FLAVOR: "nominatim" })?.endpoint).toBe(
      "/geocoder/nominatim",
    );
    expect(resolveApiCityGeocoder({ id: "vilnius" }, { GEOCODER_FLAVOR: "photon" })?.endpoint).toBe(
      "/geocoder/photon",
    );
  });

  it("honors the multi-tenant opt-out", () => {
    expect(
      resolveApiCityGeocoder(
        { id: "vilnius" },
        { GEOCODER_FLAVOR: "ptn-fst", GEOCODER_MULTI_TENANT: "false" },
      )?.multiTenant,
    ).toBe(false);
  });

  it("omits unknown geocoder flavors", () => {
    expect(resolveApiCityGeocoder({ id: "vilnius" }, { GEOCODER_FLAVOR: "pelias" })).toBeUndefined();
  });
});
