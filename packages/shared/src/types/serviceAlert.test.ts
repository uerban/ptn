import { describe, it, expect, expectTypeOf } from "vitest";
import {
  SERVICE_ALERTS_SCHEMA_VERSION,
  type Alert,
  type AlertInformedEntity,
  type ServiceAlertsResponse,
} from "./serviceAlert.js";

describe("service alerts contract", () => {
  it("starts at schema version 1", () => {
    expect(SERVICE_ALERTS_SCHEMA_VERSION).toBe(1);
  });

  it("expresses a route-at-stop selector next to a whole-route one", () => {
    const alert: Alert = {
      id: "a1",
      cause: "CONSTRUCTION",
      effect: "DETOUR",
      severity: "WARNING",
      header: [{ language: "en", text: "Detour" }, { language: "nb", text: "Omkjøring" }],
      description: [{ text: "Line 5 skips Central Station." }],
      url: [],
      activePeriods: [{ start: "2026-11-07T06:00:00Z" }],
      informedEntities: [{ routeId: "5", stopId: "central" }, { routeId: "7" }],
    };
    const body: ServiceAlertsResponse = {
      schemaVersion: SERVICE_ALERTS_SCHEMA_VERSION,
      city: "oslo",
      fetchedAt: "2026-11-07T06:01:00Z",
      stale: false,
      alerts: [alert],
    };
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("keeps every GTFS-RT EntitySelector field", () => {
    expectTypeOf<keyof AlertInformedEntity>().toEqualTypeOf<
      "agencyId" | "routeId" | "routeType" | "directionId" | "tripId" | "stopId"
    >();
  });
});
