/**
 * Setup draft and setup journal.
 *
 * The draft is what the setup screen is editing; it lives in memory only and
 * never activates anything. Committing setup writes a journal into the
 * onboarding record (one `setItem`), applies it to the decision, privacy,
 * settings and storage-choice stores, then marks it applied. A journal that
 * was committed but not applied (reload or crash in between) is applied
 * again at boot before any optional feature starts. Application is
 * idempotent, and once applied the preference stores are the only source of
 * truth: the record does not compete with them.
 */
import { create } from "zustand";
import {
  ONBOARDING_PRESETS,
  presetDecisions,
  type GuidedNetworkChoice,
  type NetworkDecision,
  type OnboardingPresetId,
  type ProtectionAxis,
} from "@pt/shared/privacy";
import {
  hasPendingJournal,
  newInstallRecord,
  onOnboardingRecordWrite,
  ONBOARDING_RECORD_KEY,
  readOnboardingRecord,
  writeOnboardingRecord,
  type OnboardingRecord,
  type OptionalStorageChoiceUpdate,
  type PresentationChoice,
} from "../services/onboardingRecord.ts";
import {
  onStorageKeyChange,
  syncStoreAcrossTabs,
  withMigrationLock,
} from "../services/crossTab.ts";
import {
  NETWORK_DECISIONS_STORAGE_KEY,
  useNetworkDecisionsStore,
} from "./networkDecisionsStore.ts";
import { usePrivacyStore } from "./privacyStore.ts";
import { usePrivacyChoicesStore } from "./privacyChoicesStore.ts";
import { useSettingsStore } from "./settingsStore.ts";

export interface SetupDraft {
  presentation: PresentationChoice;
  presetId: OnboardingPresetId | null;
  guidedChoice: GuidedNetworkChoice | null;
}

export interface CommitSetupInput {
  presetId: OnboardingPresetId;
  /** Customize only: the answer to the guided network question. */
  guidedChoice?: GuidedNetworkChoice;
  presentation?: PresentationChoice;
  storageChoices?: OptionalStorageChoiceUpdate;
  /** Highest What's new entry id shipped with this build. */
  seenWhatsNew?: number;
}

interface OnboardingState {
  record: OnboardingRecord | null;
  /** False when the record cannot be read or written (setup then runs on
   * session state only). */
  storageAvailable: boolean;
  draft: SetupDraft;
  load: () => void;
  setDraftPresentation: (presentation: PresentationChoice) => void;
  setDraftPreset: (
    presetId: OnboardingPresetId | null,
    guidedChoice?: GuidedNetworkChoice | null,
  ) => void;
  commitSetup: (input: CommitSetupInput) => Promise<OnboardingRecord>;
  removeCarriedOverOverride: (axis: ProtectionAxis) => void;
  /** Count one **Not now** answer to the alerts offer. */
  recordAlertsNotNow: () => void;
  /** Mark What's new entries up to `id` as seen; `alertsNotNow` also counts
   * one **Not now** (the card closed with its alerts item unanswered). */
  markWhatsNewSeen: (id: number, options?: { alertsNotNow?: boolean }) => void;
}

function initialDraft(): SetupDraft {
  // Map is the disclosed initial selection.
  return { presentation: { startMode: "map" }, presetId: null, guidedChoice: null };
}

/**
 * Apply a journal to the preference stores and return the record marked
 * applied. Safe to run any number of times for the same journal.
 */
export async function applyJournalToStores(
  record: OnboardingRecord,
): Promise<OnboardingRecord> {
  if (!record.decisions) return record;
  const { flows, level, storageChoices } = record.decisions;

  // Persisting a store can throw (quota, blocked storage) after its
  // in-memory state changed. Keep going so this session still gets every
  // part of the journal; the record stays authoritative for the next boot.
  await safely(() => useNetworkDecisionsStore.getState().applyDecisions(flows));
  if (level) await safely(() => usePrivacyStore.getState().setLevel(level));

  for (const [axis, value] of Object.entries(record.legacyOverrides)) {
    await safely(() =>
      usePrivacyStore.getState().setOverride(axis as ProtectionAxis, value as never),
    );
  }

  if (record.presentation) {
    const { startMode, mapDetail, nearbyCards } = record.presentation;
    await safely(() => useSettingsStore.getState().setScheduleMode(startMode === "text"));
    if (mapDetail) await safely(() => useSettingsStore.getState().setMapDetailMode(mapDetail));
    if (nearbyCards !== undefined) {
      await safely(() => useSettingsStore.getState().setEtaCardsEnabled(nearbyCards));
    }
  }

  if (storageChoices) {
    for (const [category, choice] of Object.entries(storageChoices)) {
      if (!choice) continue;
      await safely(() =>
        usePrivacyChoicesStore
          .getState()
          .setChoice(category as keyof OptionalStorageChoiceUpdate, choice),
      );
    }
  }

  return { ...record, applied: true };
}

async function safely(step: () => unknown): Promise<void> {
  try {
    await step();
  } catch {
    // See applyJournalToStores.
  }
}

/**
 * Boot step: apply a committed but unapplied journal. Runs under the
 * migration lock and re-reads the record inside it, so two tabs never apply
 * the same journal concurrently. Never throws.
 */
export async function applyPendingOnboardingJournal(): Promise<void> {
  try {
    await withMigrationLock("onboarding-journal", async () => {
      const read = readOnboardingRecord();
      if (read.status !== "ok" || !hasPendingJournal(read.record)) return;
      const applied = await applyJournalToStores(read.record);
      writeOnboardingRecord(applied);
    });
  } catch {
    // Stores keep their previous values; the journal stays pending and is
    // retried on the next boot.
  }
  useOnboardingStore.getState().load();
}

export const useOnboardingStore = create<OnboardingState>()((set, get) => ({
  record: null,
  storageAvailable: true,
  draft: initialDraft(),

  load: () => {
    const read = readOnboardingRecord();
    if (read.status === "ok") {
      set({ record: read.record, storageAvailable: true });
    } else if (read.status === "unavailable") {
      set({ storageAvailable: false });
    } else {
      set({ storageAvailable: true });
    }
  },

  setDraftPresentation: (presentation) =>
    set((state) => ({ draft: { ...state.draft, presentation } })),

  setDraftPreset: (presetId, guidedChoice = null) =>
    set((state) => ({ draft: { ...state.draft, presetId, guidedChoice } })),

  commitSetup: async (input) => {
    const now = Date.now();
    const base =
      get().record ??
      (() => {
        const read = readOnboardingRecord();
        return read.status === "ok"
          ? read.record
          : newInstallRecord({ kind: "new", classifiedAt: now });
      })();
    const flows: Record<string, NetworkDecision> = {};
    for (const [flowId, value] of Object.entries(
      presetDecisions(input.presetId, input.guidedChoice),
    )) {
      if (value) flows[flowId] = { value, source: "setup", decidedAt: now };
    }
    const journal: OnboardingRecord = {
      ...base,
      decisions: {
        preset: input.presetId,
        level: ONBOARDING_PRESETS[input.presetId].level,
        flows,
        ...(input.storageChoices ? { storageChoices: input.storageChoices } : {}),
      },
      presentation: input.presentation ?? get().draft.presentation,
      applied: false,
      seenWhatsNew: Math.max(base.seenWhatsNew, input.seenWhatsNew ?? 0),
    };
    const persisted = writeOnboardingRecord(journal);
    const applied = await applyJournalToStores(journal);
    const stored = persisted && writeOnboardingRecord(applied);
    set({ record: applied, storageAvailable: stored, draft: initialDraft() });
    return applied;
  },

  removeCarriedOverOverride: (axis) => {
    const record = get().record;
    if (!record || !(axis in record.legacyOverrides)) return;
    usePrivacyStore.getState().clearOverride(axis);
    const legacyOverrides = { ...record.legacyOverrides };
    delete legacyOverrides[axis];
    const next = { ...record, legacyOverrides };
    writeOnboardingRecord(next);
    set({ record: next });
  },

  recordAlertsNotNow: () => {
    updateRecord(get, set, (record) => ({
      ...record,
      alertsNotNow: record.alertsNotNow + 1,
    }));
  },

  markWhatsNewSeen: (id, options = {}) => {
    updateRecord(get, set, (record) => ({
      ...record,
      seenWhatsNew: Math.max(record.seenWhatsNew, id),
      alertsNotNow: record.alertsNotNow + (options.alertsNotNow ? 1 : 0),
    }));
  },
}));

/**
 * Apply `change` to the freshest record: the stored one (another tab may have
 * written since this tab last read it), else the one in memory. When storage
 * refuses the write, the change still holds for this session.
 */
function updateRecord(
  get: () => OnboardingState,
  set: (partial: Partial<OnboardingState>) => void,
  change: (record: OnboardingRecord) => OnboardingRecord,
): void {
  const read = readOnboardingRecord();
  const current = read.status === "ok" ? read.record : get().record;
  if (!current) return;
  const next = change(current);
  if (!writeOnboardingRecord(next)) set({ record: next });
}

onOnboardingRecordWrite((record) => {
  useOnboardingStore.setState({ record });
});

/**
 * Propagate decision and journal changes made in other tabs: the decision
 * store rehydrates and the record is re-read. Call once at boot.
 */
export function installPrivacyStateSync(): () => void {
  const stopDecisions = syncStoreAcrossTabs(
    NETWORK_DECISIONS_STORAGE_KEY,
    useNetworkDecisionsStore,
  );
  const stopRecord = onStorageKeyChange(ONBOARDING_RECORD_KEY, () => {
    useOnboardingStore.getState().load();
  });
  return () => {
    stopDecisions();
    stopRecord();
  };
}
