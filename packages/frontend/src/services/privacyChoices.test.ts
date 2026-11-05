import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectivePolicy } from "@pt/shared/privacy";
import { usePrivacyChoicesStore } from "../stores/privacyChoicesStore.ts";
import {
  isOptionalStorageEnabled,
  isOptionalStorageEnabledNow,
  withdrawPersonalization,
  withdrawRecents,
  withdrawViewport,
} from "./privacyChoices.ts";
import {
  PRIVACY_DATA_MIGRATION_KEY,
  PRIVACY_DATA_MIGRATION_VERSION,
} from "./privacyDataMigrationState.ts";

beforeEach(() => {
  globalThis.localStorage?.removeItem("ptn-privacy-choices");
  globalThis.localStorage?.setItem(
    PRIVACY_DATA_MIGRATION_KEY,
    PRIVACY_DATA_MIGRATION_VERSION,
  );
  usePrivacyChoicesStore.getState().reset();
});

describe("isOptionalStorageEnabled", () => {
  const allEnabled = {
    recents: "enabled",
    viewport: "enabled",
    personalization: "enabled",
  } as const;

  it("requires an explicit enabled choice", () => {
    const policy = effectivePolicy("standard");
    expect(
      isOptionalStorageEnabled(
        "recents",
        { ...allEnabled, recents: "unset" },
        policy,
      ),
    ).toBe(false);
    expect(
      isOptionalStorageEnabled(
        "recents",
        { ...allEnabled, recents: "disabled" },
        policy,
      ),
    ).toBe(false);
  });

  it("requires the active policy to permit the category", () => {
    expect(
      isOptionalStorageEnabled("recents", allEnabled, effectivePolicy("standard")),
    ).toBe(true);
    expect(
      isOptionalStorageEnabled(
        "recents",
        allEnabled,
        effectivePolicy("standard", { recentsEncryption: "off" }),
      ),
    ).toBe(false);

    expect(
      isOptionalStorageEnabled("viewport", allEnabled, effectivePolicy("strict")),
    ).toBe(true);
    expect(
      isOptionalStorageEnabled("viewport", allEnabled, effectivePolicy("paranoid")),
    ).toBe(false);

    expect(
      isOptionalStorageEnabled(
        "personalization",
        allEnabled,
        effectivePolicy("hardened"),
      ),
    ).toBe(true);
    expect(
      isOptionalStorageEnabled(
        "personalization",
        allEnabled,
        effectivePolicy("strict"),
      ),
    ).toBe(false);
  });

  it("the live helper fails closed before a user choice", () => {
    expect(isOptionalStorageEnabledNow("recents")).toBe(false);
    expect(isOptionalStorageEnabledNow("viewport")).toBe(false);
    expect(isOptionalStorageEnabledNow("personalization")).toBe(false);
  });

  it("the live helper fails closed until legacy cleanup completes", () => {
    usePrivacyChoicesStore.getState().setChoice("recents", "enabled");
    globalThis.localStorage?.removeItem(PRIVACY_DATA_MIGRATION_KEY);
    expect(isOptionalStorageEnabledNow("recents")).toBe(false);
  });

  it("fails closed while an enabled persisted choice has not hydrated", async () => {
    globalThis.localStorage?.setItem(
      "ptn-privacy-choices",
      JSON.stringify({
        state: {
          choices: {
            recents: "enabled",
            viewport: "unset",
            personalization: "unset",
          },
        },
        version: 1,
      }),
    );

    expect(isOptionalStorageEnabledNow("recents")).toBe(false);

    await usePrivacyChoicesStore.persist.rehydrate();
    expect(isOptionalStorageEnabledNow("recents")).toBe(true);
  });
});

describe("optional storage withdrawal", () => {
  it("disables recents before invoking cleanup", async () => {
    usePrivacyChoicesStore.getState().setChoice("recents", "enabled");
    const cleanup = vi.fn(async () => {
      expect(usePrivacyChoicesStore.getState().choices.recents).toBe("disabled");
    });

    await withdrawRecents(cleanup);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(usePrivacyChoicesStore.getState().choices.recents).toBe("disabled");
  });

  it("keeps future writes disabled when cleanup fails", async () => {
    usePrivacyChoicesStore.getState().setChoice("viewport", "enabled");
    const cleanup = vi.fn().mockRejectedValue(new Error("storage unavailable"));

    await expect(withdrawViewport(cleanup)).rejects.toThrow("storage unavailable");
    expect(usePrivacyChoicesStore.getState().choices.viewport).toBe("disabled");
  });

  it("withdraws personalization without changing other choices", async () => {
    const store = usePrivacyChoicesStore.getState();
    store.setChoice("recents", "enabled");
    store.setChoice("personalization", "enabled");

    await withdrawPersonalization(vi.fn().mockResolvedValue(undefined));

    expect(usePrivacyChoicesStore.getState().choices).toEqual({
      recents: "enabled",
      viewport: "unset",
      personalization: "disabled",
    });
  });
});
