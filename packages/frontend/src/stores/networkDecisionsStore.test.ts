import { beforeEach, describe, expect, it } from "vitest";
import { decisionKey } from "@pt/shared/privacy";
import {
  NETWORK_DECISIONS_STORAGE_KEY,
  useNetworkDecisionsStore,
} from "./networkDecisionsStore.ts";

const CARTO = decisionKey("external.detailed-basemap", "carto")!;
const ALERTS = decisionKey("operator.service-alerts")!;

function storedDecisions(): Record<string, { value: string }> {
  const raw = localStorage.getItem(NETWORK_DECISIONS_STORAGE_KEY);
  return (JSON.parse(raw ?? "{}") as { state: { decisions: Record<string, { value: string }> } })
    .state.decisions;
}

beforeEach(() => {
  localStorage.clear();
  useNetworkDecisionsStore.getState().reset();
});

describe("setDecision across tabs", () => {
  it("does not write back a value another tab changed since this tab last read it", () => {
    const store = useNetworkDecisionsStore.getState();
    store.setDecision("external.detailed-basemap", "allowed", "settings", "carto");

    // Another tab revokes Carto; this tab has not processed the storage event.
    const other = JSON.parse(localStorage.getItem(NETWORK_DECISIONS_STORAGE_KEY) ?? "{}");
    other.state.decisions[CARTO] = { value: "denied", source: "settings", decidedAt: 2 };
    localStorage.setItem(NETWORK_DECISIONS_STORAGE_KEY, JSON.stringify(other));
    expect(useNetworkDecisionsStore.getState().decisions[CARTO]?.value).toBe("allowed");

    store.setDecision("operator.service-alerts", "allowed", "settings");

    expect(storedDecisions()[CARTO]?.value).toBe("denied");
    expect(storedDecisions()[ALERTS]?.value).toBe("allowed");
    expect(useNetworkDecisionsStore.getState().decisions[CARTO]?.value).toBe("denied");
  });

  it("keeps this tab's decisions when nothing readable is stored", () => {
    const store = useNetworkDecisionsStore.getState();
    store.setDecision("external.detailed-basemap", "allowed", "settings", "carto");
    localStorage.setItem(NETWORK_DECISIONS_STORAGE_KEY, "{not json");

    store.setDecision("operator.service-alerts", "denied", "settings");

    expect(useNetworkDecisionsStore.getState().decisions[CARTO]?.value).toBe("allowed");
    expect(storedDecisions()[ALERTS]?.value).toBe("denied");
  });
});
