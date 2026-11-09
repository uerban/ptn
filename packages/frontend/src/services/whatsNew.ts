/**
 * What's new entries shipped with this build.
 *
 * Each entry has a numeric id that only ever grows. The onboarding record
 * stores the highest id the user has seen (`seenWhatsNew`); an entry is
 * unseen while its id is above that value. Ids, not the build version, decide
 * what to show: the package version does not change across deploys, and many
 * users never press the update button.
 *
 * Entry text is localized and shipped with the build, never fetched.
 */
import type { OnboardingRecord } from "./onboardingRecord.ts";

export interface WhatsNewEntry {
  readonly id: number;
  /** Stable topic name; surfaces attach actions by topic. */
  readonly topic: "service-alerts";
}

/** Listed oldest first; a new entry is appended with the next id. */
export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = Object.freeze([
  Object.freeze({ id: 1, topic: "service-alerts" as const }),
]);

/** Highest entry id in this build; first-run setup marks it seen. */
export const LATEST_WHATS_NEW_ID = WHATS_NEW_ENTRIES.at(-1)?.id ?? 0;

/** Entries the user has not seen yet, oldest first. A missing record has
 * nothing to show: a fresh install goes through setup instead. */
export function unseenWhatsNewEntries(
  record: Pick<OnboardingRecord, "seenWhatsNew"> | null | undefined,
): readonly WhatsNewEntry[] {
  if (!record) return [];
  return WHATS_NEW_ENTRIES.filter((entry) => entry.id > record.seenWhatsNew);
}
