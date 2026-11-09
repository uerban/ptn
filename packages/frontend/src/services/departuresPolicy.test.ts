import { describe, it, expect, beforeEach } from "vitest";
import {
  backendDeparturesAllowed,
  liveTileOverlayAllowed,
  REALTIME_FLOW,
} from "./departuresPolicy.ts";
import { usePrivacyStore } from "../stores/privacyStore.ts";
import { allowFlow, denyFlow, resetFlows } from "../test-helpers/networkDecisions.ts";

describe.each([
  ["backendDeparturesAllowed", backendDeparturesAllowed],
  ["liveTileOverlayAllowed", liveTileOverlayAllowed],
] as const)("%s", (_name, allowed) => {
  beforeEach(() => {
    usePrivacyStore.getState().reset();
    resetFlows();
  });

  it("is off while the real-time decision is unset", () => {
    expect(allowed()).toBe(false);
  });
  it("is on once real-time updates are allowed", () => {
    allowFlow(REALTIME_FLOW);
    expect(allowed()).toBe(true);
  });
  it("is off when real-time updates are denied", () => {
    denyFlow(REALTIME_FLOW);
    expect(allowed()).toBe(false);
  });
  it("follows the decision, not the protection level", async () => {
    allowFlow(REALTIME_FLOW);
    await usePrivacyStore.getState().setLevel("paranoid");
    expect(allowed()).toBe(true);
  });
});
