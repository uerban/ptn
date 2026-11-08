import { beforeEach, describe, expect, it } from "vitest";
import { getNetworkDecision } from "../privacy/canUse.ts";
import { __resetContextualPromptsForTests } from "../privacy/contextualPrompts.ts";
import { useNetworkDecisionsStore } from "../stores/networkDecisionsStore.ts";
import { useOnboardingStore } from "../stores/onboardingStore.ts";
import {
  newInstallRecord,
  readOnboardingRecord,
  writeOnboardingRecord,
  type OnboardingRecord,
} from "./onboardingRecord.ts";
import {
  __resetAlertsOfferSessionForTests,
  ALERTS_OFFER_NOT_NOW_LIMIT,
  alertsOfferOpen,
  answerAlertsOffer,
  inlineAlertsOfferVisible,
  whatsNewPendingAlerts,
} from "./serviceAlertsOffer.ts";
import { SERVICE_ALERTS_FLOW_ID } from "./serviceAlertsClient.ts";
import { LATEST_WHATS_NEW_ID } from "./whatsNew.ts";

function record(overrides: Partial<OnboardingRecord> = {}): OnboardingRecord {
  return {
    ...newInstallRecord({ kind: "new", classifiedAt: 1 }),
    applied: true,
    seenWhatsNew: LATEST_WHATS_NEW_ID,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  useNetworkDecisionsStore.getState().reset();
  __resetContextualPromptsForTests();
  __resetAlertsOfferSessionForTests();
  useOnboardingStore.setState({ record: null });
});

describe("alertsOfferOpen", () => {
  const base = { decision: "unset" as const, available: true, record: record() };

  it("is open only while undecided, in a city announcing alerts", () => {
    expect(alertsOfferOpen(base)).toBe(true);
    expect(alertsOfferOpen({ ...base, decision: "allowed" })).toBe(false);
    expect(alertsOfferOpen({ ...base, decision: "denied" })).toBe(false);
    expect(alertsOfferOpen({ ...base, available: false })).toBe(false);
  });

  it("closes after two Not now answers in total", () => {
    expect(alertsOfferOpen({ ...base, record: record({ alertsNotNow: 1 }) })).toBe(true);
    expect(
      alertsOfferOpen({ ...base, record: record({ alertsNotNow: ALERTS_OFFER_NOT_NOW_LIMIT }) }),
    ).toBe(false);
  });
});

describe("inlineAlertsOfferVisible", () => {
  const base = {
    decision: "unset" as const,
    available: true,
    record: record(),
    notNowThisSession: false,
  };

  it("shows for an undecided profile that has seen What's new", () => {
    expect(inlineAlertsOfferVisible(base)).toBe(true);
  });

  it("waits while What's new still has to ask", () => {
    const legacy = record({ seenWhatsNew: 0 });
    expect(whatsNewPendingAlerts(legacy)).toBe(true);
    expect(inlineAlertsOfferVisible({ ...base, record: legacy })).toBe(false);
  });

  it("stays away for the rest of the session after Not now", () => {
    expect(inlineAlertsOfferVisible({ ...base, notNowThisSession: true })).toBe(false);
  });
});

describe("answerAlertsOffer", () => {
  beforeEach(() => {
    writeOnboardingRecord(record());
    useOnboardingStore.getState().load();
  });

  it("Turn on allows exactly the alerts flow", () => {
    answerAlertsOffer("allowed");
    expect(getNetworkDecision(SERVICE_ALERTS_FLOW_ID).value).toBe("allowed");
    expect(Object.keys(useNetworkDecisionsStore.getState().decisions)).toEqual([
      SERVICE_ALERTS_FLOW_ID,
    ]);
  });

  it("Don't show again records denied", () => {
    answerAlertsOffer("denied");
    expect(getNetworkDecision(SERVICE_ALERTS_FLOW_ID).value).toBe("denied");
  });

  it("Not now leaves the flow unset and counts once in the record", () => {
    answerAlertsOffer("not-now");
    expect(getNetworkDecision(SERVICE_ALERTS_FLOW_ID).value).toBe("unset");
    const read = readOnboardingRecord();
    expect(read.status === "ok" && read.record.alertsNotNow).toBe(1);
    expect(useOnboardingStore.getState().record?.alertsNotNow).toBe(1);
  });
});
