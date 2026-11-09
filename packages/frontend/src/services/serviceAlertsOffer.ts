/**
 * The alerts offer: how the app asks about service alerts.
 *
 * Alerts arrive passively, so there is no deliberate action to attach a
 * contextual prompt to. Instead the offer appears in two places, sharing one
 * **Not now** count kept in the onboarding record:
 *
 * - the alerts item of the What's new card (existing installations, after the
 *   update), with **Turn on** · **Not now**;
 * - an inline row on the stop departure sheet, line view and route results
 *   for everyone else, with **Turn on** · **Not now** and **Don't show again**
 *   in a secondary menu.
 *
 * The offer shows only while the decision is `unset` and the city's stored
 * realtime availability lists alerts. Deciding whether to show it reads
 * stored state only: it never makes an alerts request. Two **Not now**
 * answers in total end the asking; Settings still offers alerts. After a
 * **Not now** the inline row stays away for the rest of the session.
 */
import { create } from "zustand";
import { resolveNetworkDecision } from "@pt/shared/privacy";
import { answerContextualPrompt } from "../privacy/contextualPrompts.ts";
import { useNetworkDecisionsStore } from "../stores/networkDecisionsStore.ts";
import { useOnboardingStore } from "../stores/onboardingStore.ts";
import type { OnboardingRecord } from "./onboardingRecord.ts";
import { useRealtimeKindStatus } from "./realtimeAvailability.ts";
import { SERVICE_ALERTS_FLOW_ID } from "./serviceAlertsClient.ts";
import { unseenWhatsNewEntries } from "./whatsNew.ts";

/** **Not now** answers, across both places, that end the asking. */
export const ALERTS_OFFER_NOT_NOW_LIMIT = 2;

/** Surface name for the session memory of contextual prompts. */
export const ALERTS_OFFER_SURFACE = "alerts-offer";

export type AlertsOfferAnswer = "allowed" | "not-now" | "denied";

interface AlertsOfferSession {
  /** A **Not now** was given in this page session. */
  notNowThisSession: boolean;
}

/** In-memory only: a new session may offer again. */
const useAlertsOfferSession = create<AlertsOfferSession>()(() => ({
  notNowThisSession: false,
}));

export interface AlertsOfferInputs {
  decision: "allowed" | "denied" | "unset";
  /** The city's stored realtime availability lists alerts. */
  available: boolean;
  record: Pick<OnboardingRecord, "alertsNotNow"> | null;
}

/** Whether the offer may appear at all, in either place. */
export function alertsOfferOpen({ decision, available, record }: AlertsOfferInputs): boolean {
  if (decision !== "unset" || !available) return false;
  return (record?.alertsNotNow ?? 0) < ALERTS_OFFER_NOT_NOW_LIMIT;
}

/** True while What's new still has to show its alerts item. */
export function whatsNewPendingAlerts(
  record: Pick<OnboardingRecord, "seenWhatsNew"> | null,
): boolean {
  return unseenWhatsNewEntries(record).some((entry) => entry.topic === "service-alerts");
}

/**
 * Whether the inline row may show: the offer is open, no **Not now** was
 * given this session, and What's new is not about to ask the same question.
 */
export function inlineAlertsOfferVisible(
  inputs: AlertsOfferInputs & {
    record: Pick<OnboardingRecord, "alertsNotNow" | "seenWhatsNew"> | null;
    notNowThisSession: boolean;
  },
): boolean {
  if (!alertsOfferOpen(inputs)) return false;
  if (inputs.notNowThisSession) return false;
  return !whatsNewPendingAlerts(inputs.record);
}

/**
 * Record one answer. **Turn on** grants exactly the alerts flow, **Don't show
 * again** records `denied`, **Not now** leaves it unset and counts once.
 */
export function answerAlertsOffer(answer: AlertsOfferAnswer): void {
  if (answer === "not-now") {
    useOnboardingStore.getState().recordAlertsNotNow();
    useAlertsOfferSession.setState({ notNowThisSession: true });
    return;
  }
  answerContextualPrompt(answer, SERVICE_ALERTS_FLOW_ID, ALERTS_OFFER_SURFACE);
}

/** The card closed with its alerts item unanswered: counts as **Not now**. */
export function noteAlertsOfferSkipped(): void {
  useAlertsOfferSession.setState({ notNowThisSession: true });
}

function useAlertsDecision(): AlertsOfferInputs["decision"] {
  return useNetworkDecisionsStore(
    (s) => resolveNetworkDecision(s.decisions, SERVICE_ALERTS_FLOW_ID).value,
  );
}

/** React binding: the offer is open for `cityId` (What's new uses this). */
export function useAlertsOfferOpen(cityId: string): boolean {
  const decision = useAlertsDecision();
  const available = useRealtimeKindStatus(cityId, "alerts") === "available";
  const record = useOnboardingStore((s) => s.record);
  return alertsOfferOpen({ decision, available, record });
}

/** React binding for the inline row. */
export function useInlineAlertsOffer(cityId: string): boolean {
  const decision = useAlertsDecision();
  const available = useRealtimeKindStatus(cityId, "alerts") === "available";
  const record = useOnboardingStore((s) => s.record);
  const notNowThisSession = useAlertsOfferSession((s) => s.notNowThisSession);
  return inlineAlertsOfferVisible({ decision, available, record, notNowThisSession });
}

/** Test-only: forget this session's **Not now**. */
export function __resetAlertsOfferSessionForTests(): void {
  useAlertsOfferSession.setState({ notNowThisSession: false });
}
