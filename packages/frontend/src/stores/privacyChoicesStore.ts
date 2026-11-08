import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createTolerantJSONStorage } from "../services/tolerantLocalStorage.ts";

export const OPTIONAL_STORAGE_CATEGORIES = [
  "recents",
  "viewport",
  "personalization",
] as const;

export type OptionalStorageCategory =
  (typeof OPTIONAL_STORAGE_CATEGORIES)[number];
export type OptionalStorageChoice = "unset" | "enabled" | "disabled";

export interface OptionalStorageChoices {
  recents: OptionalStorageChoice;
  viewport: OptionalStorageChoice;
  personalization: OptionalStorageChoice;
}

export const DEFAULT_OPTIONAL_STORAGE_CHOICES: Readonly<OptionalStorageChoices> =
  Object.freeze({
    recents: "unset",
    viewport: "unset",
    personalization: "unset",
  });

interface PrivacyChoicesState {
  choices: OptionalStorageChoices;
  setChoice: (
    category: OptionalStorageCategory,
    choice: OptionalStorageChoice,
  ) => void;
  reset: () => void;
}

function freshDefaults(): OptionalStorageChoices {
  return { ...DEFAULT_OPTIONAL_STORAGE_CHOICES };
}

function isOptionalStorageChoice(value: unknown): value is OptionalStorageChoice {
  return value === "unset" || value === "enabled" || value === "disabled";
}

function sanitizeChoices(value: unknown): OptionalStorageChoices {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const result = freshDefaults();
  for (const category of OPTIONAL_STORAGE_CATEGORIES) {
    if (isOptionalStorageChoice(raw[category])) {
      result[category] = raw[category];
    }
  }
  return result;
}

/**
 * Standing choices for optional browser-local persistence. `unset` is
 * deliberately operationally identical to disabled; it only lets the UI offer
 * a quiet contextual choice once. Writers must call privacyChoices.ts rather
 * than treating this persisted preference as sufficient on its own.
 */
export const usePrivacyChoicesStore = create<PrivacyChoicesState>()(
  persist(
    (set) => ({
      choices: freshDefaults(),
      setChoice: (category, choice) =>
        set((state) => ({
          choices: { ...state.choices, [category]: choice },
        })),
      reset: () => set({ choices: freshDefaults() }),
    }),
    {
      name: "ptn-privacy-choices",
      storage: createTolerantJSONStorage(),
      version: 1,
      partialize: (state) => ({ choices: state.choices }),
      // No optional category is accepted unless it contains a current
      // allowlisted value, including when the persisted version changes.
      migrate: (persisted) => {
        const stored = persisted as Partial<PrivacyChoicesState> | undefined;
        return { choices: sanitizeChoices(stored?.choices) };
      },
      merge: (persisted, current) => {
        const stored = persisted as Partial<PrivacyChoicesState> | undefined;
        return {
          ...current,
          choices: sanitizeChoices(stored?.choices),
        };
      },
    },
  ),
);
