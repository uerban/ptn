/**
 * The onboarding record: installation classification, the setup journal and
 * a few one-shot markers, kept in ONE localStorage entry and always written
 * with a single `setItem`, so a reload can never observe half of an update.
 *
 * This module is deliberately store-free. The installation classifier runs
 * before any store module is imported (store hydration rewrites the state it
 * needs to read), and it shares this schema.
 */
import {
  isOnboardingPresetId,
  isPrivacyLevel,
  sanitizeNetworkDecisions,
  sanitizeProtectionOverrides,
  type NetworkDecisionMap,
  type OnboardingPresetId,
  type PrivacyLevel,
  type ProtectionPolicy,
} from "@pt/shared/privacy";
import type { OptionalStorageChoices } from "../stores/privacyChoicesStore.ts";
import {
  isMapDetailMode,
  isOptionalStorageChoice,
  OPTIONAL_STORAGE_CATEGORIES,
  type MapDetailMode,
} from "./preferenceValues.ts";
import { safeLocalStorage } from "./tolerantLocalStorage.ts";

export const ONBOARDING_RECORD_KEY = "ptn-onboarding";
export const ONBOARDING_RECORD_VERSION = 1;

export type InstallKind = "new" | "existing";

export interface InstallClassification {
  readonly kind: InstallKind;
  /** City to preselect in setup (a stored city without other app state). */
  readonly preselectedCityId?: string;
}

export type StartMode = "map" | "text";
export interface PresentationChoice {
  readonly startMode: StartMode;
  readonly mapDetail?: MapDetailMode;
  readonly nearbyCards?: boolean;
}

export type OptionalStorageChoiceUpdate = Partial<OptionalStorageChoices>;

/** What setup (or the legacy migration) decided, waiting to be applied. */
export interface SetupDecisions {
  readonly preset: OnboardingPresetId | null;
  /** Protection level to apply; `null` keeps the current one. */
  readonly level: PrivacyLevel | null;
  readonly flows: NetworkDecisionMap;
  readonly storageChoices?: OptionalStorageChoiceUpdate;
}

export interface OnboardingRecord {
  readonly version: typeof ONBOARDING_RECORD_VERSION;
  readonly install: InstallClassification;
  /** The setup journal. `null` until setup (or the legacy migration) commits. */
  readonly decisions: SetupDecisions | null;
  readonly presentation: PresentationChoice | null;
  /** True once the journal reached every preference store. */
  readonly applied: boolean;
  /** Protection overrides carried over from the previous version. */
  readonly legacyOverrides: Partial<ProtectionPolicy>;
  /** Highest What's new entry id the user has seen. */
  readonly seenWhatsNew: number;
  /** How many times the alerts offer was answered with "Not now". */
  readonly alertsNotNow: number;
}

export type OnboardingRecordRead =
  | { readonly status: "ok"; readonly record: OnboardingRecord }
  | { readonly status: "missing" }
  | { readonly status: "corrupt" }
  | { readonly status: "unavailable" };

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

const START_MODES: readonly StartMode[] = ["map", "text"];

function sanitizePresentation(raw: unknown): PresentationChoice | null {
  if (!isRecordObject(raw)) return null;
  if (!START_MODES.includes(raw.startMode as StartMode)) return null;
  const result: { -readonly [K in keyof PresentationChoice]: PresentationChoice[K] } = {
    startMode: raw.startMode as StartMode,
  };
  if (isMapDetailMode(raw.mapDetail)) result.mapDetail = raw.mapDetail;
  if (typeof raw.nearbyCards === "boolean") result.nearbyCards = raw.nearbyCards;
  return result;
}

function sanitizeStorageChoices(raw: unknown): OptionalStorageChoiceUpdate | undefined {
  if (!isRecordObject(raw)) return undefined;
  const result: Record<string, string> = {};
  for (const category of OPTIONAL_STORAGE_CATEGORIES) {
    const value = raw[category];
    if (isOptionalStorageChoice(value)) result[category] = value;
  }
  return result as OptionalStorageChoiceUpdate;
}

function sanitizeSetupDecisions(raw: unknown): SetupDecisions | null {
  if (!isRecordObject(raw)) return null;
  const decisions: SetupDecisions = {
    preset: isOnboardingPresetId(raw.preset) ? raw.preset : null,
    level: isPrivacyLevel(raw.level) ? raw.level : null,
    flows: sanitizeNetworkDecisions(raw.flows),
  };
  const storageChoices = sanitizeStorageChoices(raw.storageChoices);
  return storageChoices ? { ...decisions, storageChoices } : decisions;
}

function sanitizeInstall(raw: unknown): InstallClassification | undefined {
  if (!isRecordObject(raw)) return undefined;
  if (raw.kind !== "new" && raw.kind !== "existing") return undefined;
  const install: {
    -readonly [K in keyof InstallClassification]: InstallClassification[K];
  } = { kind: raw.kind };
  if (typeof raw.preselectedCityId === "string" && raw.preselectedCityId) {
    install.preselectedCityId = raw.preselectedCityId;
  }
  return install;
}

/** Validate an untrusted stored record. Returns `undefined` when unusable. */
export function sanitizeOnboardingRecord(raw: unknown): OnboardingRecord | undefined {
  if (!isRecordObject(raw) || raw.version !== ONBOARDING_RECORD_VERSION) {
    return undefined;
  }
  const install = sanitizeInstall(raw.install);
  if (!install) return undefined;
  return {
    version: ONBOARDING_RECORD_VERSION,
    install,
    decisions: sanitizeSetupDecisions(raw.decisions),
    presentation: sanitizePresentation(raw.presentation),
    applied: raw.applied === true,
    legacyOverrides: sanitizeProtectionOverrides(raw.legacyOverrides),
    seenWhatsNew: nonNegativeInt(raw.seenWhatsNew),
    alertsNotNow: nonNegativeInt(raw.alertsNotNow),
  };
}

export function readOnboardingRecord(
  storage: Pick<Storage, "getItem"> | undefined = safeLocalStorage(),
): OnboardingRecordRead {
  if (!storage) return { status: "unavailable" };
  let text: string | null;
  try {
    text = storage.getItem(ONBOARDING_RECORD_KEY);
  } catch {
    return { status: "unavailable" };
  }
  const unsaved = unsavedRecords.get(storage);
  if (text === null) return unsaved ? { status: "ok", record: unsaved } : { status: "missing" };
  try {
    const record = sanitizeOnboardingRecord(JSON.parse(text));
    if (record) return { status: "ok", record };
  } catch {
    // Unreadable, as below.
  }
  return unsaved ? { status: "ok", record: unsaved } : { status: "corrupt" };
}

/**
 * Records the browser refused to store (storage full or read-only), kept for
 * this session so a failed write never sends the user back through setup or
 * blocks the app. They are not stored, so the next launch classifies again.
 */
const unsavedRecords = new WeakMap<object, OnboardingRecord>();

/** Persist the whole record with one `setItem`. Returns false on failure. */
export function writeOnboardingRecord(
  record: OnboardingRecord,
  storage: Pick<Storage, "setItem"> | undefined = safeLocalStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(ONBOARDING_RECORD_KEY, JSON.stringify(record));
    unsavedRecords.delete(storage);
  } catch {
    unsavedRecords.set(storage, record);
    return false;
  }
  for (const listener of writeListeners) {
    try {
      listener(record);
    } catch {
      // One listener must not stop the others.
    }
  }
  return true;
}

type RecordWriteListener = (record: OnboardingRecord) => void;
const writeListeners = new Set<RecordWriteListener>();

/** Observe record writes made in this tab (other tabs fire `storage`). */
export function onOnboardingRecordWrite(listener: RecordWriteListener): () => void {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

export function newInstallRecord(
  install: InstallClassification,
): OnboardingRecord {
  return {
    version: ONBOARDING_RECORD_VERSION,
    install,
    decisions: null,
    presentation: null,
    applied: false,
    legacyOverrides: {},
    seenWhatsNew: 0,
    alertsNotNow: 0,
  };
}

/** Existing installations skip first-run setup; new ones finish it by
 * committing a setup journal. */
export function isSetupComplete(record: OnboardingRecord | null | undefined): boolean {
  if (!record) return false;
  if (record.install.kind === "existing") return true;
  return record.decisions !== null;
}

/** A committed journal that has not reached every store yet. */
export function hasPendingJournal(record: OnboardingRecord | null | undefined): boolean {
  return !!record && record.decisions !== null && !record.applied;
}
