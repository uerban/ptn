import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionKey } from "@pt/shared/privacy";
import {
  NETWORK_DECISIONS_STORAGE_KEY,
  useNetworkDecisionsStore,
} from "./networkDecisionsStore.ts";
import { installPrivacyStateSync } from "./onboardingStore.ts";

const CARTO = decisionKey("external.detailed-basemap", "carto")!;
const ALERTS = decisionKey("operator.service-alerts")!;

type Stored = Record<string, { value: string; decidedAt?: number }>;

function storedDecisions(): Stored {
  const raw = localStorage.getItem(NETWORK_DECISIONS_STORAGE_KEY);
  return (JSON.parse(raw ?? "{}") as { state: { decisions: Stored } })
    .state.decisions;
}

beforeEach(() => {
  localStorage.clear();
  useNetworkDecisionsStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setDecision across tabs", () => {
  it("does not write back a value another tab changed since this tab last read it", () => {
    const store = useNetworkDecisionsStore.getState();
    store.setDecision("external.detailed-basemap", "allowed", "settings", "carto");

    // Another tab revokes Carto; this tab has not processed the storage event.
    const other = JSON.parse(localStorage.getItem(NETWORK_DECISIONS_STORAGE_KEY) ?? "{}");
    other.state.decisions[CARTO] = { value: "denied", source: "settings", decidedAt: Date.now() + 1 };
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

describe("decisions that could not be stored", () => {
  it("keeps a revocation whose write was refused when another decision follows", () => {
    const store = useNetworkDecisionsStore.getState();
    store.setDecision("external.detailed-basemap", "allowed", "settings", "carto");
    const setItem = vi
      .spyOn(localStorage, "setItem")
      .mockImplementationOnce(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
    store.setDecision("external.detailed-basemap", "denied", "settings", "carto");
    expect(setItem).toHaveBeenCalled();
    expect(storedDecisions()[CARTO]?.value).toBe("allowed");

    store.setDecision("operator.service-alerts", "allowed", "settings");

    expect(useNetworkDecisionsStore.getState().decisions[CARTO]?.value).toBe("denied");
    expect(storedDecisions()[CARTO]?.value).toBe("denied");
    expect(storedDecisions()[ALERTS]?.value).toBe("allowed");
  });
});

describe("concurrent writes from another tab", () => {
  async function otherTabWrites(decisions: Record<string, unknown>): Promise<void> {
    localStorage.setItem(
      NETWORK_DECISIONS_STORAGE_KEY,
      JSON.stringify({ state: { decisions }, version: 1 }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: NETWORK_DECISIONS_STORAGE_KEY }));
    await Promise.resolve();
  }

  it("writes back a revocation another tab overwrote with an older value", async () => {
    const stop = installPrivacyStateSync();
    try {
      const store = useNetworkDecisionsStore.getState();
      store.setDecision("external.detailed-basemap", "allowed", "settings", "carto");
      const before = storedDecisions()[CARTO]!;
      store.setDecision("external.detailed-basemap", "denied", "settings", "carto");

      // The other tab read the map before the revocation was stored, then
      // wrote its own alerts change on top of that copy.
      await otherTabWrites({
        [CARTO]: { value: "allowed", source: "settings", decidedAt: before.decidedAt },
        [ALERTS]: { value: "allowed", source: "settings", decidedAt: Date.now() + 5 },
      });

      expect(useNetworkDecisionsStore.getState().decisions[CARTO]?.value).toBe("denied");
      expect(storedDecisions()[CARTO]?.value).toBe("denied");
      expect(storedDecisions()[ALERTS]?.value).toBe("allowed");
    } finally {
      stop();
    }
  });

  it("writes back a return to ask-first another tab overwrote", async () => {
    const stop = installPrivacyStateSync();
    try {
      const store = useNetworkDecisionsStore.getState();
      store.setDecision("external.detailed-basemap", "allowed", "settings", "carto");
      const before = storedDecisions()[CARTO]!;
      store.setDecision("external.detailed-basemap", "unset", "settings", "carto");

      await otherTabWrites({
        [CARTO]: { value: "allowed", source: "settings", decidedAt: before.decidedAt },
      });

      expect(useNetworkDecisionsStore.getState().decisions[CARTO]).toBeUndefined();
      expect(storedDecisions()[CARTO]).toBeUndefined();
    } finally {
      stop();
    }
  });

  it("takes a newer decision from another tab", async () => {
    const stop = installPrivacyStateSync();
    try {
      useNetworkDecisionsStore
        .getState()
        .setDecision("external.detailed-basemap", "denied", "settings", "carto");

      await otherTabWrites({
        [CARTO]: { value: "allowed", source: "settings", decidedAt: Date.now() + 5 },
      });

      expect(useNetworkDecisionsStore.getState().decisions[CARTO]?.value).toBe("allowed");
      expect(storedDecisions()[CARTO]?.value).toBe("allowed");
    } finally {
      stop();
    }
  });
});
