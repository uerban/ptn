import { beforeEach, describe, it, expect } from "vitest";
import { isTransitousAllowed } from "./transitousAvailability.ts";
import { usePrivacyStore } from "../stores/privacyStore.ts";
import { allowFlow, denyFlow, resetFlows } from "../test-helpers/networkDecisions.ts";

describe("isTransitousAllowed", () => {
  beforeEach(() => {
    resetFlows();
    usePrivacyStore.getState().reset();
  });

  it("is off until Transitous routing is allowed", () => {
    expect(isTransitousAllowed()).toBe(false);
    allowFlow("external.remote-routing", "transitous");
    expect(isTransitousAllowed()).toBe(true);
  });

  it("is off when Transitous routing is denied", () => {
    denyFlow("external.remote-routing", "transitous");
    expect(isTransitousAllowed()).toBe(false);
  });

  it("does not follow the operator's routing decision or the level", async () => {
    allowFlow("operator.remote-routing");
    expect(isTransitousAllowed()).toBe(false);
    allowFlow("external.remote-routing", "transitous");
    await usePrivacyStore.getState().setLevel("paranoid");
    expect(isTransitousAllowed()).toBe(true);
  });
});
