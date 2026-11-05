import { describe, it, expect, beforeEach } from "vitest";
import type { SelfHostedGeocoderConfig } from "@pt/shared";
import {
  resolveSelfHostedConfig,
  normalizeSelfHostedConfigForCity,
  hasServerSideGeocoder,
  setRuntimeGeocoderConfig,
  __resetRuntimeGeocoderConfigForTests,
  unregisterSelfHostedGeocoder,
} from "./registerSelfHosted.ts";
import { geocoderRegistry } from "./instance.ts";
import { CITIES } from "../../config/cities.ts";

const PER_CITY: SelfHostedGeocoderConfig = {
  kind: "self-hosted",
  endpoint: "https://geo.example/per-city",
  flavor: "nominatim",
  multiTenant: false,
};
const JSON_CFG: SelfHostedGeocoderConfig = {
  kind: "self-hosted",
  endpoint: "https://geo.example/json",
  flavor: "photon",
  multiTenant: true,
};
const PTN_FST_JSON_CFG: SelfHostedGeocoderConfig = {
  kind: "self-hosted",
  endpoint: "/geocoder/ptn-fst",
  flavor: "ptn-fst",
  multiTenant: true,
};

const CITIES_FIXTURE = [
  { id: "withgeo", geocoder: PER_CITY },
  { id: "nogeo" },
] as const;

describe("resolveSelfHostedConfig (AC-2 — pure, cities-injected)", () => {
  it("per-city geocoder beats a different JSON config (override wins)", () => {
    expect(resolveSelfHostedConfig("withgeo", JSON_CFG, CITIES_FIXTURE)).toBe(PER_CITY);
  });
  it("no per-city geocoder + non-null JSON → JSON (fallback)", () => {
    expect(resolveSelfHostedConfig("nogeo", JSON_CFG, CITIES_FIXTURE)).toBe(JSON_CFG);
  });
  it("no per-city geocoder + null JSON → null", () => {
    expect(resolveSelfHostedConfig("nogeo", null, CITIES_FIXTURE)).toBeNull();
  });
  it("unknown cityId + null JSON → null", () => {
    expect(resolveSelfHostedConfig("nope", null, CITIES_FIXTURE)).toBeNull();
  });
});

describe("normalizeSelfHostedConfigForCity", () => {
  it("rewrites the runtime PTN FST sentinel to the active city route", () => {
    expect(normalizeSelfHostedConfigForCity(PTN_FST_JSON_CFG, "vilnius")).toEqual({
      ...PTN_FST_JSON_CFG,
      endpoint: "/api/vilnius/address-search",
    });
    expect(normalizeSelfHostedConfigForCity(PTN_FST_JSON_CFG, "tricity")).toEqual({
      ...PTN_FST_JSON_CFG,
      endpoint: "/api/tricity/address-search",
    });
  });

  it("leaves concrete self-hosted endpoints untouched", () => {
    expect(normalizeSelfHostedConfigForCity(JSON_CFG, "vilnius")).toBe(JSON_CFG);
  });
});

describe("hasServerSideGeocoder (AC-3f — stateful over the cached JSON)", () => {
  beforeEach(() => { __resetRuntimeGeocoderConfigForTests(); });

  it("false when nothing cached and the city has no per-city geocoder", () => {
    expect(hasServerSideGeocoder("nogeo-real")).toBe(false);
  });
  it("true after a non-null self-hosted JSON is cached", () => {
    setRuntimeGeocoderConfig(JSON_CFG);
    expect(hasServerSideGeocoder("nogeo-real")).toBe(true);
  });
  it("false again after reset", () => {
    setRuntimeGeocoderConfig(JSON_CFG);
    __resetRuntimeGeocoderConfigForTests();
    expect(hasServerSideGeocoder("nogeo-real")).toBe(false);
  });
});

describe("syncSelfHostedRegistration (AC-12 — register/unregister for the active city)", () => {
  beforeEach(() => {
    __resetRuntimeGeocoderConfigForTests();
    // Ensure no stale self-hosted adapter from a prior `it`. Use the real
    // unregister so the module-level `currentConfig` dedup guard is reset too —
    // a raw `geocoderRegistry.unregister` removes the adapter but leaves
    // `currentConfig` set, so re-registering the identical config would
    // short-circuit and never re-add the adapter.
    unregisterSelfHostedGeocoder();
    geocoderRegistry.unregister("self-hosted");
  });

  it("registers the self-hosted adapter when the JSON resolves", async () => {
    const { syncSelfHostedRegistration } = await import("./registerSelfHosted.ts");
    setRuntimeGeocoderConfig(JSON_CFG);
    syncSelfHostedRegistration("anycity");
    expect(geocoderRegistry.adapters().some((a) => a.id === "self-hosted")).toBe(true);
  });

  it("unregisters when nothing resolves for the city", async () => {
    const { syncSelfHostedRegistration } = await import("./registerSelfHosted.ts");
    setRuntimeGeocoderConfig(JSON_CFG);
    syncSelfHostedRegistration("anycity");
    expect(geocoderRegistry.adapters().some((a) => a.id === "self-hosted")).toBe(true);
    __resetRuntimeGeocoderConfigForTests(); // JSON now null
    syncSelfHostedRegistration("nogeo-real");
    expect(geocoderRegistry.adapters().some((a) => a.id === "self-hosted")).toBe(false);
  });

  it("AC-12: a per-CityConfig.geocoder city → register; bare city → unregister (real exports, injected cities)", async () => {
    // Drive the per-CityConfig.geocoder branch WITHOUT the runtime JSON and
    // WITHOUT mutating CITIES — inject the cities fixture (Should-fix 10). This
    // proves a config-bearing city registers and a bare city unregisters through
    // the REAL register/unregister path (no JSON cached, so resolution comes
    // purely from CityConfig.geocoder).
    const { syncSelfHostedRegistration } = await import("./registerSelfHosted.ts");
    // CITIES_FIXTURE = [{ id:"withgeo", geocoder: PER_CITY }, { id:"nogeo" }]
    // (declared at the top of this file for the AC-2 suite — reuse it).
    syncSelfHostedRegistration("withgeo", CITIES_FIXTURE);
    expect(geocoderRegistry.adapters().some((a) => a.id === "self-hosted")).toBe(true);
    syncSelfHostedRegistration("nogeo", CITIES_FIXTURE);
    expect(geocoderRegistry.adapters().some((a) => a.id === "self-hosted")).toBe(false);
  });
});

describe("AC-3a (tricity geocoder no-op): tricity has no server-side geocoder from EITHER source", () => {
  beforeEach(() => {
    __resetRuntimeGeocoderConfigForTests(); // runtime /geocoder-config.json absent
  });

  it("AC-3a (tricity geocoder no-op): tricity CityConfig carries no geocoder field", () => {
    expect(CITIES.find((c) => c.id === "tricity")?.geocoder).toBeUndefined();
  });

  it("AC-3a (tricity geocoder no-op): resolveSelfHostedConfig('tricity', null) over REAL CITIES → null", () => {
    // No per-city geocoder, no runtime JSON → null (rung 2 is a no-op).
    expect(resolveSelfHostedConfig("tricity", null)).toBeNull();
  });

  it("AC-3a (tricity geocoder no-op): hasServerSideGeocoder('tricity') → false with the runtime JSON absent", () => {
    expect(hasServerSideGeocoder("tricity")).toBe(false);
  });
});

// Deviation from the plan snippet: the file already imports the REAL `CITIES`
// (top of file) — reuse it here rather than adding a duplicate
// `import { CITIES as REAL_CITIES }`.
describe("vilnius has no server-side geocoder source (AC-V0)", () => {
  beforeEach(() => { __resetRuntimeGeocoderConfigForTests(); });
  it("real vilnius CityConfig carries no geocoder; resolver returns null with no runtime JSON", () => {
    expect(CITIES.find((c) => c.id === "vilnius")?.geocoder).toBeUndefined();
    expect(resolveSelfHostedConfig("vilnius", null, CITIES)).toBeNull();
    expect(hasServerSideGeocoder("vilnius")).toBe(false);
  });
});
