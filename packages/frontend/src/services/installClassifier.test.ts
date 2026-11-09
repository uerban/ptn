import { beforeEach, describe, expect, it } from "vitest";
import { LEGACY_NETWORK_FLOORS_V1 } from "@pt/shared/privacy";
import {
  classifyInstallation,
  mapLegacyNetworkDecisions,
} from "./installClassifier.ts";
import {
  ONBOARDING_RECORD_KEY,
  readOnboardingRecord,
  type OnboardingRecord,
} from "./onboardingRecord.ts";

function seed(key: string, state: Record<string, unknown>): void {
  localStorage.setItem(key, JSON.stringify({ state, version: 0 }));
}

function classified(): OnboardingRecord {
  const record = classifyInstallation(localStorage);
  if (!record) throw new Error("storage unavailable");
  return record;
}

function flows(record: OnboardingRecord): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record.decisions?.flows ?? {}).map(([k, v]) => [k, v.value]),
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("classifyInstallation", () => {
  it("classifies an empty profile as a new installation without decisions", () => {
    const record = classified();
    expect(record.install.kind).toBe("new");
    expect(record.decisions).toBeNull();
    expect(readOnboardingRecord().status).toBe("ok");
  });

  it("treats a stored city alone as new and preselects it", () => {
    seed("ptn-city", { activeCity: { id: "gdansk" } });
    const record = classified();
    expect(record.install.kind).toBe("new");
    // Stored under its former id; preselected under the current one.
    expect(record.install.preselectedCityId).toBe("tricity");
  });

  it.each([
    "ptn-settings",
    "ptn-privacy",
    "ptn-privacy-choices",
    "ptn-favorites",
    "ptn-privacy-data-migration",
  ])("treats %s as an existing installation", (key) => {
    localStorage.setItem(key, key === "ptn-privacy-data-migration" ? "1" : "{}");
    const record = classified();
    expect(record.install.kind).toBe("existing");
    expect(record.applied).toBe(false);
  });

  it("keeps the first classification after setup writes store state and the page reloads", () => {
    expect(classified().install.kind).toBe("new");
    const text = localStorage.getItem(ONBOARDING_RECORD_KEY);
    // Setup writes preference stores (e.g. through the language picker)...
    seed("ptn-settings", { language: "pl" });
    seed("ptn-privacy", { level: "standard", overrides: {} });
    // ...and a reload mid-setup classifies again.
    expect(classifyInstallation(localStorage)?.install.kind).toBe("new");
    expect(localStorage.getItem(ONBOARDING_RECORD_KEY)).toBe(text);
  });

  it("does not trust a corrupt record: setup runs again and nothing is granted", () => {
    seed("ptn-settings", { mapDetailMode: "detailed" });
    localStorage.setItem(ONBOARDING_RECORD_KEY, "{not json");
    const record = classified();
    expect(record.install.kind).toBe("new");
    expect(record.decisions).toBeNull();
  });

  it("re-classifies a record with an unknown version as corrupt", () => {
    localStorage.setItem(ONBOARDING_RECORD_KEY, JSON.stringify({ version: 99 }));
    expect(classified().install.kind).toBe("new");
  });

  it("reports unavailable storage without throwing", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(classifyInstallation(broken)).toBeNull();
  });

  it("reads stored network overrides that store hydration would drop", () => {
    seed("ptn-privacy", {
      level: "standard",
      overrides: { realTimePolling: "disabled-schedule-only" },
    });
    seed("ptn-settings", { mapDetailMode: "detailed" });
    const record = classified();
    expect(flows(record)["operator.realtime"]).toBe("denied");
    expect(flows(record)["external.detailed-basemap@carto"]).toBe("allowed");
  });

  it("is idempotent: a second boot leaves the record untouched", () => {
    seed("ptn-privacy", { level: "strict", overrides: {} });
    const first = classified();
    const text = localStorage.getItem(ONBOARDING_RECORD_KEY);
    classifyInstallation(localStorage);
    expect(localStorage.getItem(ONBOARDING_RECORD_KEY)).toBe(text);
    expect(first.legacyOverrides).toEqual({ m11TileDefense: "prefetch-padding-decoy" });
  });

  it("carries the decoy timer over only for strict installations", () => {
    for (const level of ["baseline", "standard", "hardened", "paranoid"]) {
      localStorage.clear();
      seed("ptn-privacy", { level, overrides: {} });
      expect(classified().legacyOverrides).toEqual({});
    }
  });

  it("never grants service alerts or the server nearby lookup", () => {
    seed("ptn-privacy", { level: "baseline", overrides: {} });
    seed("ptn-settings", {
      mapDetailMode: "detailed",
      searchProvider: "remote",
      routingMode: "remote-primary",
      routingProvider: "transitous",
    });
    const result = flows(classified());
    expect(result["operator.service-alerts"]).toBeUndefined();
    expect(result["operator.nearby-stop-centroid"]).toBeUndefined();
    expect(Object.values(classified().decisions?.flows ?? {}).every((d) => d.source === "legacy")).toBe(true);
  });
});

describe("mapLegacyNetworkDecisions", () => {
  const standard = LEGACY_NETWORK_FLOORS_V1.standard;
  const strict = LEGACY_NETWORK_FLOORS_V1.strict;

  it("live departures that were on stay allowed", () => {
    expect(mapLegacyNetworkDecisions(standard, {})["operator.realtime"]?.value).toBe(
      "allowed",
    );
    expect(
      mapLegacyNetworkDecisions(LEGACY_NETWORK_FLOORS_V1.hardened, {})["operator.realtime"]
        ?.value,
    ).toBe("allowed");
  });

  it("live departures the level forbade become denied", () => {
    expect(mapLegacyNetworkDecisions(strict, {})["operator.realtime"]?.value).toBe(
      "denied",
    );
  });

  it("detailed maps need both the axis and the detailed map setting", () => {
    expect(
      mapLegacyNetworkDecisions(standard, { mapDetailMode: "detailed" })[
        "external.detailed-basemap@carto"
      ]?.value,
    ).toBe("allowed");
    expect(
      mapLegacyNetworkDecisions(standard, { mapDetailMode: "micromap" })[
        "external.detailed-basemap@carto"
      ],
    ).toBeUndefined();
    // No stored setting: consent is not inferred from a default.
    expect(
      mapLegacyNetworkDecisions(standard, {})["external.detailed-basemap@carto"],
    ).toBeUndefined();
    expect(
      mapLegacyNetworkDecisions(strict, { mapDetailMode: "detailed" })[
        "external.detailed-basemap@carto"
      ]?.value,
    ).toBe("denied");
  });

  it("server nearby lookup is never allowed: unset when it ran, denied when forbidden", () => {
    expect(
      mapLegacyNetworkDecisions(standard, {})["operator.nearby-stop-centroid"],
    ).toBeUndefined();
    expect(
      mapLegacyNetworkDecisions(strict, {})["operator.nearby-stop-centroid"]?.value,
    ).toBe("denied");
  });

  it("selected third-party search and routing stay allowed", () => {
    const result = mapLegacyNetworkDecisions(standard, {
      searchProvider: "remote",
      routingMode: "provider-fallback",
      routingProvider: "transitous",
    });
    expect(result["external.stop-search"]?.value).toBe("allowed");
    expect(result["external.remote-routing@transitous"]?.value).toBe("allowed");
    expect(result["operator.remote-routing"]).toBeUndefined();
    expect(result["external.place-search@nominatim"]).toBeUndefined();
  });

  it("selected operator routing stays allowed without granting external routing", () => {
    const result = mapLegacyNetworkDecisions(standard, {
      routingMode: "remote-primary",
      routingProvider: "operator",
    });
    expect(result["operator.remote-routing"]?.value).toBe("allowed");
    expect(
      Object.keys(result).some((key) => key.startsWith("external.remote-routing")),
    ).toBe(false);
  });

  it("unselected remote features stay unset", () => {
    const result = mapLegacyNetworkDecisions(standard, {
      searchProvider: "local",
      routingMode: "on-device",
      routingProvider: "operator",
    });
    expect(result["external.stop-search"]).toBeUndefined();
    expect(result["operator.remote-routing"]).toBeUndefined();
  });

  it("third-party and remote flows the level forbade become denied", () => {
    const result = mapLegacyNetworkDecisions(strict, {
      searchProvider: "remote",
      routingMode: "remote-primary",
      routingProvider: "transitous",
    });
    expect(result["external.stop-search"]?.value).toBe("denied");
    expect(result["external.remote-routing@transitous"]?.value).toBe("denied");
    expect(result["operator.remote-routing"]?.value).toBe("denied");
    expect(result["external.place-search@nominatim"]?.value).toBe("denied");
    expect(result["operator.place-search"]?.value).toBe("denied");
  });

  it("the operator geocoder stays allowed where the level permitted it", () => {
    expect(mapLegacyNetworkDecisions(standard, {})["operator.place-search"]?.value).toBe(
      "allowed",
    );
  });

  it("place search on the server stays off where residency was local-only", () => {
    expect(
      mapLegacyNetworkDecisions(LEGACY_NETWORK_FLOORS_V1.hardened, {})["operator.place-search"]
        ?.value,
    ).toBe("denied");
    expect(
      mapLegacyNetworkDecisions({ ...standard, poiResidency: "local-only" }, {})[
        "operator.place-search"
      ]?.value,
    ).toBe("denied");
  });
});

describe("legacy place search protections", () => {
  it("denies place search for a standard install whose residency override was local-only", () => {
    seed("ptn-privacy", { level: "standard", overrides: { poiResidency: "local-only" } });
    expect(flows(classified())["operator.place-search"]).toBe("denied");
  });

  it("denies place search for a hardened install", () => {
    seed("ptn-privacy", { level: "hardened", overrides: {} });
    expect(flows(classified())["operator.place-search"]).toBe("denied");
  });
});
