import { describe, it, expect, expectTypeOf } from "vitest";
import {
  SERVICE_ALERTS_SCHEMA_VERSION,
  type Alert,
  type AlertInformedEntity,
  type ServiceAlertsResponse,
} from "./serviceAlert.js";
import golden from "./__fixtures__/service-alerts-response.json";

describe("service alerts contract", () => {
  it("starts at schema version 1", () => {
    expect(SERVICE_ALERTS_SCHEMA_VERSION).toBe(1);
  });

  it("the server's reply fixture has exactly the contract's fields", () => {
    const body: ServiceAlertsResponse = golden as ServiceAlertsResponse;
    expect(Object.keys(body).sort()).toEqual(
      ["alerts", "city", "fetchedAt", "schemaVersion", "stale"],
    );
    expect(body.schemaVersion).toBe(SERVICE_ALERTS_SCHEMA_VERSION);
    const alertKeys: (keyof Alert)[] = [
      "activePeriods",
      "cause",
      "description",
      "effect",
      "header",
      "id",
      "informedEntities",
      "severity",
      "url",
    ];
    for (const alert of body.alerts) expect(Object.keys(alert).sort()).toEqual(alertKeys);
  });

  it("keeps every GTFS-RT EntitySelector field", () => {
    expectTypeOf<keyof AlertInformedEntity>().toEqualTypeOf<
      "agencyId" | "routeId" | "routeType" | "directionId" | "tripId" | "stopId"
    >();
  });
});
