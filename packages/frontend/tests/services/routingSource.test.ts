// packages/frontend/tests/services/routingSource.test.ts
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { RaptorQuery } from "@pt/shared";
import {
  isRemoteRoutingAllowed, gateRemoteRouting, RoutingNotAllowedError,
  planRequestFromQuery, makeRemoteStopPlanner,
} from "../../src/services/routingSource.ts";
import { allowFlow, denyFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";

const allow = () => true;
const deny = () => false;

beforeEach(() => resetFlows());

const query = {
  entryStops: [{ stopId: "A", walkSecs: 10 }],
  exitStops: [{ stopId: "B", walkSecs: 20 }],
  departureSecs: 3600,
  maxRounds: 5,
  mobilityProfile: "wheelchair",
} as unknown as RaptorQuery;

describe("isRemoteRoutingAllowed", () => {
  it("is off until the operator's routing is allowed, and off again when denied", () => {
    expect(isRemoteRoutingAllowed()).toBe(false);
    allowFlow("operator.remote-routing");
    expect(isRemoteRoutingAllowed()).toBe(true);
    denyFlow("operator.remote-routing");
    expect(isRemoteRoutingAllowed()).toBe(false);
  });
});

describe("gateRemoteRouting", () => {
  it("runs the thunk when remote routing is allowed", async () => {
    const run = vi.fn(async () => ["x"]);
    await expect(gateRemoteRouting(run, allow)).resolves.toEqual(["x"]);
    expect(run).toHaveBeenCalledOnce();
  });
  it("throws RoutingNotAllowedError and never runs the thunk when it is not", async () => {
    const run = vi.fn(async () => ["x"]);
    await expect(gateRemoteRouting(run, deny)).rejects.toBeInstanceOf(RoutingNotAllowedError);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("planRequestFromQuery", () => {
  it("maps a RaptorQuery + date into a PlanRequest (excludedModes omitted)", () => {
    expect(planRequestFromQuery(query, "20260624")).toEqual({
      entryStops: [{ stopId: "A", walkSecs: 10 }],
      exitStops: [{ stopId: "B", walkSecs: 20 }],
      departureSecs: 3600,
      date: "20260624",
      maxRounds: 5,
      mobilityProfile: "wheelchair",
    });
  });
});

describe("planRequestFromQuery sends the engine profile, never the rider's", () => {
  it.each([
    ["default", "default"],
    ["wheelchair", "wheelchair"],
    ["bicycle", "bicycle"],
    ["vision_impaired", "default"],
  ])("%s → %s", (profile, expected) => {
    const req = planRequestFromQuery({ ...query, mobilityProfile: profile } as unknown as RaptorQuery, "20260624");
    expect(req.mobilityProfile).toBe(expected);
  });

  it("leaves an absent profile absent", () => {
    const { mobilityProfile: _, ...rest } = query;
    expect(planRequestFromQuery(rest as RaptorQuery, "20260624").mobilityProfile).toBeUndefined();
  });

  it("keeps the walking speed and minimum transfer on the device", () => {
    const req = planRequestFromQuery(
      { ...query, mobilityProfile: "vision_impaired", walkSpeedMps: 3.5 / 3.6, minTransferSecs: 180 } as unknown as RaptorQuery,
      "20260624",
    );
    expect(req).not.toHaveProperty("walkSpeedMps");
    expect(req).not.toHaveProperty("minTransferSecs");
  });
});

describe("makeRemoteStopPlanner", () => {
  it("builds a planner that POSTs the mapped PlanRequest through the gate", async () => {
    const plan = vi.fn(async () => [{ legs: [], boardSecs: 0, alightSecs: 0, transfers: 0 }]);
    const planner = makeRemoteStopPlanner(plan, allow);
    const out = await planner(query, "20260624");
    expect(plan).toHaveBeenCalledWith(planRequestFromQuery(query, "20260624"));
    expect(out).toHaveLength(1);
  });
  it("the planner throws (does not call plan) when remote routing is not allowed", async () => {
    const plan = vi.fn(async () => []);
    const planner = makeRemoteStopPlanner(plan, deny);
    await expect(planner(query, "20260624"))
      .rejects.toBeInstanceOf(RoutingNotAllowedError);
    expect(plan).not.toHaveBeenCalled();
  });
});


it("refuses unsupported remote route exclusions before making a request", async () => {
  const plan = vi.fn(async () => []);
  const planner = makeRemoteStopPlanner(plan, allow);
  await expect(planner({ ...query, excludedRouteIds: ["minibus-532"] }, "20260624"))
    .rejects.toThrow("on-device planning");
  expect(plan).not.toHaveBeenCalled();
});
