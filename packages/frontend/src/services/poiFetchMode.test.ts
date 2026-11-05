import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clampPoiFetchModeToPolicy, resolvePoiFetchMode } from "./poiFetchMode.ts";
import type { PrivacyPolicy } from "@pt/shared";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { usePrivacyStore } from "../stores/privacyStore.ts";

// Mock the WHOLE registerSelfHosted module so resolvePoiFetchMode's namespace
// import (`import * as selfHosted`) resolves through the mock. Include EVERY
// export poiFetchMode.ts might touch (Should-fix 17 — a partial factory returns
// undefined for any other export if the production path ever calls one). Today
// poiFetchMode.ts only calls hasServerSideGeocoder, but list the others as
// no-ops so a future call does not silently get undefined.
vi.mock("./geocoder/registerSelfHosted.ts", () => ({
  hasServerSideGeocoder: vi.fn(() => false),
  resolveSelfHostedConfig: vi.fn(() => null),
  setRuntimeGeocoderConfig: vi.fn(),
  syncSelfHostedRegistration: vi.fn(),
  __resetRuntimeGeocoderConfigForTests: vi.fn(),
}));

// Per-city rung: resolvePoiFetchMode now imports CITIES from config/cities.ts. Mock it so the
// precedence ACs can pin tricity's poiFetchMode without mutating the real CITIES list (the public
// resolvePoiFetchMode takes no injectable cities).
const fixtureCities = vi.hoisted(() => [
  { id: "tricity", poiFetchMode: "lazy-tile" },
  { id: "vilnius" },
  { id: "control" },
]);
vi.mock("../config/cities.ts", () => ({
  CITIES: fixtureCities,
  getAvailableCities: () => fixtureCities,
}));

import * as selfHosted from "./geocoder/registerSelfHosted.ts";

async function freshResolve() {
  vi.resetModules();
  const mod = await import("./poiFetchMode.ts");
  return mod.resolvePoiFetchMode;
}

describe("resolvePoiFetchMode precedence (AC-3, AC-11)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    const { useSettingsStore } = await import("../stores/settingsStore.ts");
    useSettingsStore.getState().setPoiFetchModeOverride(undefined);
    vi.mocked(selfHosted.hasServerSideGeocoder).mockReturnValue(false);
    vi.mocked(selfHosted.hasServerSideGeocoder).mockClear();
  });

  it("AC-3a: user override 'eager-bundle' wins even with a configured geocoder", async () => {
    const { useSettingsStore } = await import("../stores/settingsStore.ts");
    useSettingsStore.getState().setPoiFetchModeOverride("eager-bundle");
    vi.mocked(selfHosted.hasServerSideGeocoder).mockReturnValue(true);
    const resolve = await freshResolve();
    expect(resolve("c")).toBe("eager-bundle");
    // User override short-circuits BEFORE the geocoder check — assert it was NOT
    // consulted (precedence rung 1 wins without reaching rung 2).
    expect(selfHosted.hasServerSideGeocoder).not.toHaveBeenCalled();
  });

  it("AC-3b: no override + geocoder configured no longer forces server-side (rung 2 dropped) → operator default", async () => {
    vi.mocked(selfHosted.hasServerSideGeocoder).mockReturnValue(true);
    const resolve = await freshResolve();
    // After dropping rung 2, a configured geocoder is a CAPABILITY, not a mode
    // decider: a city with no per-city/global mode falls to the eager floor.
    expect(resolve("c")).toBe("eager-bundle");
    // resolvePoiFetchMode no longer consults the geocoder at all — that read moved to the
    // augmentation gate. Pin that it is NOT called here.
    expect(selfHosted.hasServerSideGeocoder).not.toHaveBeenCalled();
  });

  it("AC-3c: no override + no geocoder + VITE lazy-tile → lazy-tile", async () => {
    vi.stubEnv("VITE_PT_POI_FETCH_MODE", "lazy-tile");
    const resolve = await freshResolve();
    expect(resolve("c")).toBe("lazy-tile");
  });

  it("AC-3d / AC-11: no override + no geocoder + no operator default → eager-bundle", async () => {
    const resolve = await freshResolve();
    expect(resolve("c")).toBe("eager-bundle");
  });

  it("AC-3e: no override + no geocoder + VITE server-side → server-side (operatorDefault honors it)", async () => {
    vi.stubEnv("VITE_PT_POI_FETCH_MODE", "server-side");
    const resolve = await freshResolve();
    expect(resolve("c")).toBe("server-side");
  });
});

describe("resolvePoiFetchMode per-city operator rung", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    const { useSettingsStore } = await import("../stores/settingsStore.ts");
    useSettingsStore.getState().setPoiFetchModeOverride(undefined);
    vi.mocked(selfHosted.hasServerSideGeocoder).mockReturnValue(false);
    vi.mocked(selfHosted.hasServerSideGeocoder).mockClear();
  });

  it("AC-1: per-city operator override beats global VITE (unset)", async () => {
    const resolve = await freshResolve();
    expect(resolve("tricity")).toBe("lazy-tile");
  });

  it("AC-4: per-city override beats a GLOBAL VITE set to something else", async () => {
    vi.stubEnv("VITE_PT_POI_FETCH_MODE", "eager-bundle");
    const resolve = await freshResolve();
    expect(resolve("tricity")).toBe("lazy-tile");
  });

  it("AC-2: per-USER override still wins over the per-city operator default", async () => {
    const { useSettingsStore } = await import("../stores/settingsStore.ts");
    useSettingsStore.getState().setPoiFetchModeOverride("eager-bundle");
    const resolve = await freshResolve();
    expect(resolve("tricity")).toBe("eager-bundle");
    // User override short-circuits BEFORE the geocoder check (rung 1 wins).
    expect(selfHosted.hasServerSideGeocoder).not.toHaveBeenCalled();
  });

  it("AC-2 (server-side variant): user override 'server-side' wins over per-city lazy-tile", async () => {
    const { useSettingsStore } = await import("../stores/settingsStore.ts");
    useSettingsStore.getState().setPoiFetchModeOverride("server-side");
    const resolve = await freshResolve();
    expect(resolve("tricity")).toBe("server-side");
    expect(selfHosted.hasServerSideGeocoder).not.toHaveBeenCalled();
  });

  it("AC-3: a configured geocoder does NOT override the per-city operator default (rung 2 dropped)", async () => {
    // Geocoder true ONLY for tricity; false for the control city.
    vi.mocked(selfHosted.hasServerSideGeocoder).mockImplementation(
      (id: string) => id === "tricity",
    );
    const resolve = await freshResolve();
    // tricity carries per-city poiFetchMode "lazy-tile" (cities mock above); the
    // geocoder no longer pierces it.
    expect(resolve("tricity")).toBe("lazy-tile");
    // control has no per-city mode and no override → eager floor.
    expect(resolve("control")).toBe("eager-bundle");
    // The "consulted with the cityId" coverage moves to the augmentation gate which IS the new
    // caller; resolvePoiFetchMode no longer calls it.
    expect(selfHosted.hasServerSideGeocoder).not.toHaveBeenCalled();
  });

  it("AC-5: default-off when the field is omitted → eager-bundle", async () => {
    const resolve = await freshResolve();
    expect(resolve("vilnius")).toBe("eager-bundle"); // no field, no override, no geocoder, no VITE
  });
});

describe("scoping over the REAL CITIES", () => {
  // Restore module state in afterEach (NOT at the end of the it body) so a mid-test throw cannot
  // strand the unmock and poison the earlier precedence block that relies on the cities STUB.
  afterEach(() => {
    vi.doUnmock("../config/cities.ts");
    vi.resetModules();
  });

  it("AC-V3: ONLY tricity + vilnius carry a per-city poiFetchMode (exact, order-pinned set-equality)", async () => {
    const real = await vi.importActual<typeof import("../config/cities.ts")>("../config/cities.ts");
    // order-pinned to the live CITIES array order: vilnius (idx 0), tricity (idx 1)
    expect(real.CITIES.filter((c) => c.poiFetchMode !== undefined).map((c) => c.id))
      .toEqual(["vilnius", "tricity"]);
    expect(real.CITIES.find((c) => c.id === "tricity")?.poiFetchMode).toBe("lazy-tile");
    expect(real.CITIES.find((c) => c.id === "vilnius")?.poiFetchMode).toBe("lazy-tile");
  });

  it("AC-V4: every NON-POI frontend city resolves eager; both POI cities resolve lazy-tile", async () => {
    // Drive the PUBLIC resolver against the REAL list by un-mocking cities for
    // THIS module load. resetModules + a doMock to importActual gives the real
    // CITIES to the freshly imported resolvePoiFetchMode.
    vi.resetModules();
    vi.doMock("../config/cities.ts", async () => await vi.importActual("../config/cities.ts"));
    const { useSettingsStore } = await import("../stores/settingsStore.ts");
    useSettingsStore.getState().setPoiFetchModeOverride(undefined);
    vi.mocked(selfHosted.hasServerSideGeocoder).mockReturnValue(false);
    const real = await vi.importActual<typeof import("../config/cities.ts")>("../config/cities.ts");
    const { resolvePoiFetchMode } = await import("./poiFetchMode.ts");
    // SANITY GUARD: prove the REAL CITIES are in effect — both POI cities must
    // resolve "lazy-tile" through the real list (else the loop below is vacuous).
    expect(resolvePoiFetchMode("tricity")).toBe("lazy-tile");
    expect(resolvePoiFetchMode("vilnius")).toBe("lazy-tile");
    expect(real.CITIES.length).toBeGreaterThan(2);
    for (const id of real.CITIES
      .filter((c) => c.id !== "tricity" && c.id !== "vilnius")
      .map((c) => c.id)) {
      expect(resolvePoiFetchMode(id)).toBe("eager-bundle");
    }
    // (afterEach restores the cities mock + module registry — do NOT rely on a
    // tail vi.doUnmock here; a throw above would otherwise strand it.)
  });
});

describe("clampPoiFetchModeToPolicy (privacy residency ceiling)", () => {
  // Only poiResidency is read; cast a partial as the full policy for the unit.
  const policy = (poiResidency: "user-choice" | "local-only") =>
    ({ poiResidency }) as unknown as PrivacyPolicy;

  it("local-only clamps server-side -> eager-bundle", () => {
    expect(clampPoiFetchModeToPolicy("server-side", policy("local-only"))).toBe("eager-bundle");
  });

  it("user-choice leaves server-side intact", () => {
    expect(clampPoiFetchModeToPolicy("server-side", policy("user-choice"))).toBe("server-side");
  });

  it("local-only leaves the local modes (eager-bundle, lazy-tile) unchanged", () => {
    expect(clampPoiFetchModeToPolicy("eager-bundle", policy("local-only"))).toBe("eager-bundle");
    expect(clampPoiFetchModeToPolicy("lazy-tile", policy("local-only"))).toBe("lazy-tile");
  });
});

describe("vilnius precedence over the REAL CITIES (AC-V0/AC-V1/AC-V2)", () => {
  afterEach(() => {
    vi.doUnmock("../config/cities.ts");
    vi.resetModules();
  });

  async function realResolve() {
    vi.resetModules();
    vi.doMock("../config/cities.ts", async () => await vi.importActual("../config/cities.ts"));
    const { useSettingsStore } = await import("../stores/settingsStore.ts");
    useSettingsStore.getState().setPoiFetchModeOverride(undefined);
    vi.mocked(selfHosted.hasServerSideGeocoder).mockReturnValue(false);
    vi.mocked(selfHosted.hasServerSideGeocoder).mockClear();
    const { resolvePoiFetchMode } = await import("./poiFetchMode.ts");
    return resolvePoiFetchMode;
  }

  it("AC-V1: vilnius resolves lazy-tile through the per-city rung (no override/geocoder/VITE)", async () => {
    const resolve = await realResolve();
    expect(resolve("vilnius")).toBe("lazy-tile");
  });

  it("AC-V0: vilnius has no server-side geocoder — the augmentation gate capability read is false for it", async () => {
    // Source-empty assertion (not just boolean false): the REAL resolveSelfHostedConfig
    // with NO runtime JSON and NO per-city geocoder on vilnius must resolve null, so a
    // stray /geocoder-config.json fixture cannot pass this AC for the wrong reason.
    vi.resetModules();
    vi.doUnmock("./geocoder/registerSelfHosted.ts");
    vi.doMock("../config/cities.ts", async () => await vi.importActual("../config/cities.ts"));
    const real = await vi.importActual<typeof import("../config/cities.ts")>("../config/cities.ts");
    expect(real.CITIES.find((c) => c.id === "vilnius")?.geocoder).toBeUndefined();
    const gh = await vi.importActual<typeof import("./geocoder/registerSelfHosted.ts")>(
      "./geocoder/registerSelfHosted.ts",
    );
    gh.__resetRuntimeGeocoderConfigForTests();
    expect(gh.resolveSelfHostedConfig("vilnius", null, real.CITIES)).toBeNull();
    expect(gh.hasServerSideGeocoder("vilnius")).toBe(false);
    vi.doMock("./geocoder/registerSelfHosted.ts", () => ({
      hasServerSideGeocoder: vi.fn(() => false),
      resolveSelfHostedConfig: vi.fn(() => null),
      setRuntimeGeocoderConfig: vi.fn(),
      syncSelfHostedRegistration: vi.fn(),
      __resetRuntimeGeocoderConfigForTests: vi.fn(),
    }));
  });

  it("AC-V2: per-USER override still wins for vilnius (eager-bundle AND server-side); geocoder NOT consulted", async () => {
    vi.resetModules();
    vi.doMock("../config/cities.ts", async () => await vi.importActual("../config/cities.ts"));
    const { useSettingsStore } = await import("../stores/settingsStore.ts");
    vi.mocked(selfHosted.hasServerSideGeocoder).mockReturnValue(false);
    vi.mocked(selfHosted.hasServerSideGeocoder).mockClear();
    useSettingsStore.getState().setPoiFetchModeOverride("eager-bundle");
    const { resolvePoiFetchMode } = await import("./poiFetchMode.ts");
    expect(resolvePoiFetchMode("vilnius")).toBe("eager-bundle");
    expect(selfHosted.hasServerSideGeocoder).not.toHaveBeenCalled();
    useSettingsStore.getState().setPoiFetchModeOverride("server-side");
    expect(resolvePoiFetchMode("vilnius")).toBe("server-side");
  });
});

describe("resolvePoiFetchMode applies the privacy residency clamp (AC-PR)", () => {
  afterEach(() => {
    useSettingsStore.setState({ poiFetchModeOverride: undefined });
    usePrivacyStore.setState({ level: "standard", overrides: {} });
  });

  it("AC-PR1: a local-only (hardened) policy clamps an explicit server-side override to eager-bundle", () => {
    useSettingsStore.setState({ poiFetchModeOverride: "server-side" });
    usePrivacyStore.setState({ level: "hardened", overrides: {} });
    // override is the highest rung -> raw resolves "server-side"; the hardened
    // policy (poiResidency: "local-only") clamps it to the local floor.
    expect(resolvePoiFetchMode("vilnius")).toBe("eager-bundle");
  });

  it("AC-PR2: a user-choice (standard) policy keeps the server-side override", () => {
    useSettingsStore.setState({ poiFetchModeOverride: "server-side" });
    usePrivacyStore.setState({ level: "standard", overrides: {} });
    expect(resolvePoiFetchMode("vilnius")).toBe("server-side");
  });

  it("AC-PR3: a standard level with an explicit poiResidency:local-only override clamps server-side to eager-bundle", () => {
    // The clamp must follow the EFFECTIVE policy (getPolicy = effectivePolicy(level, overrides)),
    // not the bare level: standard's floor is user-choice, but a tightening override to
    // local-only ratchets the effective axis to local-only, so the server-side mode is clamped.
    useSettingsStore.setState({ poiFetchModeOverride: "server-side" });
    usePrivacyStore.setState({ level: "standard", overrides: { poiResidency: "local-only" } });
    expect(resolvePoiFetchMode("vilnius")).toBe("eager-bundle");
  });
});
