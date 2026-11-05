import type { PrivacyPolicy } from "@pt/shared";
import {
  usePrivacyChoicesStore,
  type OptionalStorageCategory,
  type OptionalStorageChoices,
} from "../stores/privacyChoicesStore.ts";
import { getPolicy } from "../stores/privacyStore.ts";
import { isPrivacyDataMigrationComplete } from "./privacyDataMigrationState.ts";

export function isOptionalStorageEnabled(
  category: OptionalStorageCategory,
  choices: Readonly<OptionalStorageChoices>,
  policy: PrivacyPolicy,
): boolean {
  if (choices[category] !== "enabled") return false;

  switch (category) {
    case "recents":
      return policy.recentsEncryption !== "off";
    case "viewport":
      return policy.viewportPersistence !== "off";
    case "personalization":
      return policy.stopUsageRetention !== "off";
  }
}

/** Call-time backstop for future optional-storage writers. */
export function isOptionalStorageEnabledNow(
  category: OptionalStorageCategory,
): boolean {
  return (
    isPrivacyDataMigrationComplete() &&
    isOptionalStorageEnabled(
      category,
      usePrivacyChoicesStore.getState().choices,
      getPolicy(),
    )
  );
}

export type OptionalStorageCleanup = () => Promise<void>;

async function withdraw(
  category: OptionalStorageCategory,
  deleteExisting: OptionalStorageCleanup,
): Promise<void> {
  // Close the writer gate before asynchronous deletion begins. If cleanup
  // fails, callers surface/retry the error while future writes stay disabled.
  usePrivacyChoicesStore.getState().setChoice(category, "disabled");
  await deleteExisting();
}

export function withdrawRecents(
  deleteExisting: OptionalStorageCleanup,
): Promise<void> {
  return withdraw("recents", deleteExisting);
}

export function withdrawViewport(
  deleteExisting: OptionalStorageCleanup,
): Promise<void> {
  return withdraw("viewport", deleteExisting);
}

export function withdrawPersonalization(
  deleteExisting: OptionalStorageCleanup,
): Promise<void> {
  return withdraw("personalization", deleteExisting);
}
