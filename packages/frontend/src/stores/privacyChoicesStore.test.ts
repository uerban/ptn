import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONAL_STORAGE_CHOICES,
  usePrivacyChoicesStore,
} from "./privacyChoicesStore.ts";

beforeEach(() => {
  globalThis.localStorage?.removeItem("ptn-privacy-choices");
  usePrivacyChoicesStore.getState().reset();
});

describe("privacyChoicesStore", () => {
  it("starts with every optional storage category unset", () => {
    expect(usePrivacyChoicesStore.getState().choices).toEqual(
      DEFAULT_OPTIONAL_STORAGE_CHOICES,
    );
  });

  it("updates one choice without changing the others", () => {
    usePrivacyChoicesStore.getState().setChoice("recents", "enabled");
    expect(usePrivacyChoicesStore.getState().choices).toEqual({
      recents: "enabled",
      viewport: "unset",
      personalization: "unset",
    });
  });

  it("persists only the versioned choices payload", () => {
    usePrivacyChoicesStore.getState().setChoice("viewport", "disabled");
    const parsed = JSON.parse(
      globalThis.localStorage?.getItem("ptn-privacy-choices") ?? "{}",
    );
    expect(parsed.version).toBe(1);
    expect(parsed.state).toEqual({
      choices: {
        recents: "unset",
        viewport: "disabled",
        personalization: "unset",
      },
    });
  });

  it("sanitizes invalid and missing persisted choices to unset", () => {
    globalThis.localStorage?.setItem(
      "ptn-privacy-choices",
      JSON.stringify({
        state: {
          choices: {
            recents: "enabled",
            viewport: "yes-please",
          },
        },
        version: 1,
      }),
    );
    usePrivacyChoicesStore.persist.rehydrate();

    expect(usePrivacyChoicesStore.getState().choices).toEqual({
      recents: "enabled",
      viewport: "unset",
      personalization: "unset",
    });
  });

  it("reset returns every category to unset", () => {
    const store = usePrivacyChoicesStore.getState();
    store.setChoice("recents", "enabled");
    store.setChoice("viewport", "disabled");
    store.setChoice("personalization", "enabled");
    usePrivacyChoicesStore.getState().reset();
    expect(usePrivacyChoicesStore.getState().choices).toEqual(
      DEFAULT_OPTIONAL_STORAGE_CHOICES,
    );
  });
});
