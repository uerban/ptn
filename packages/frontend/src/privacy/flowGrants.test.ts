import { beforeEach, describe, expect, it } from "vitest";
import { useNetworkDecisionsStore } from "../stores/networkDecisionsStore.ts";
import { canUse, getNetworkDecision } from "./canUse.ts";
import {
  __resetContextualPromptsForTests,
  answerContextualPrompt,
  mayOfferUnprompted,
} from "./contextualPrompts.ts";
import { grantFlow } from "./flowGrants.ts";

const decisions = () => useNetworkDecisionsStore.getState().decisions;

beforeEach(() => {
  localStorage.clear();
  useNetworkDecisionsStore.getState().reset();
  __resetContextualPromptsForTests();
});

describe("grantFlow", () => {
  it("records allowed for exactly one flow and provider", () => {
    expect(grantFlow("external.detailed-basemap", "settings", "carto")).toBe(true);
    expect(Object.keys(decisions())).toEqual(["external.detailed-basemap@carto"]);
    expect(canUse("external.detailed-basemap", "carto")).toBe(true);
  });

  it("keeps the source of a flow that is already allowed", () => {
    grantFlow("operator.realtime", "settings");
    expect(grantFlow("operator.realtime", "contextual")).toBe(true);
    expect(getNetworkDecision("operator.realtime").source).toBe("settings");
  });

  it("leaves a flow whose hard constraint fails untouched", () => {
    expect(grantFlow("external.detailed-basemap", "settings", "unknownmaps")).toBe(false);
    expect(grantFlow("external.detailed-basemap", "settings")).toBe(false);
    expect(decisions()).toEqual({});
  });

  it("writes nothing for a necessary flow, which needs no decision", () => {
    expect(grantFlow("operator.transit-data", "settings")).toBe(true);
    expect(decisions()).toEqual({});
  });

  it("refuses unknown flows", () => {
    expect(grantFlow("operator.something-else", "settings")).toBe(false);
    expect(decisions()).toEqual({});
  });
});

describe("contextual prompts", () => {
  it("Not now records nothing and silences only that surface and provider", () => {
    expect(answerContextualPrompt("not-now", "external.detailed-basemap", "map", "carto")).toBe(
      false,
    );
    expect(decisions()).toEqual({});
    expect(mayOfferUnprompted("external.detailed-basemap", "map", "carto")).toBe(false);
    expect(mayOfferUnprompted("external.detailed-basemap", "settings", "carto")).toBe(true);
    expect(mayOfferUnprompted("external.detailed-basemap", "map", "other")).toBe(true);
  });

  it("Don't ask again records denied, which silences every surface", () => {
    answerContextualPrompt("denied", "operator.realtime", "departures");
    expect(getNetworkDecision("operator.realtime")).toEqual({
      value: "denied",
      source: "contextual",
    });
    expect(mayOfferUnprompted("operator.realtime", "elsewhere")).toBe(false);
  });

  it("Allow grants with a contextual source", () => {
    expect(answerContextualPrompt("allowed", "operator.realtime", "departures")).toBe(true);
    expect(getNetworkDecision("operator.realtime")).toEqual({
      value: "allowed",
      source: "contextual",
    });
  });
});
