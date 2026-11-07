import { beforeEach, describe, expect, it } from "vitest";
import {
  effectivePolicy,
  matchOnboardingPreset,
  type GuidedNetworkChoice,
  type OnboardingPresetId,
} from "@pt/shared/privacy";
import { canUse } from "../privacy/canUse.ts";
import { classifyInstallation } from "../services/installClassifier.ts";
import {
  ONBOARDING_RECORD_KEY,
  readOnboardingRecord,
  writeOnboardingRecord,
  type OnboardingRecord,
  type StartMode,
} from "../services/onboardingRecord.ts";
import { useNetworkDecisionsStore } from "./networkDecisionsStore.ts";
import {
  applyPendingOnboardingJournal,
  installPrivacyStateSync,
  useOnboardingStore,
} from "./onboardingStore.ts";
import { usePrivacyChoicesStore } from "./privacyChoicesStore.ts";
import { getCurrentLevel, usePrivacyStore } from "./privacyStore.ts";
import { useSettingsStore } from "./settingsStore.ts";

function resetStores(): void {
  useNetworkDecisionsStore.getState().reset();
  usePrivacyStore.getState().reset();
  usePrivacyChoicesStore.getState().reset();
  useSettingsStore.getState().setScheduleMode(false);
  useOnboardingStore.setState({ record: null, storageAvailable: true });
}

/** Simulate a reload: memory is gone, stores re-read localStorage. */
async function reload(): Promise<void> {
  useOnboardingStore.setState({ record: null });
  await useNetworkDecisionsStore.persist.rehydrate();
  await usePrivacyStore.persist.rehydrate();
  await useSettingsStore.persist.rehydrate();
  await usePrivacyChoicesStore.persist.rehydrate();
}

function record(): OnboardingRecord {
  const read = readOnboardingRecord();
  if (read.status !== "ok") throw new Error(read.status);
  return read.record;
}

function seed(key: string, state: Record<string, unknown>): void {
  localStorage.setItem(key, JSON.stringify({ state, version: 0 }));
}

beforeEach(() => {
  localStorage.clear();
  resetStores();
  localStorage.clear();
});

const PRESETS: [OnboardingPresetId, GuidedNetworkChoice | undefined][] = [
  ["recommended", undefined],
  ["strict", undefined],
  ["customize", "live-information"],
  ["customize", "ask-first"],
];
const MODES: StartMode[] = ["map", "text"];

describe("setup commit: preset × presentation", () => {
  for (const [presetId, guided] of PRESETS) {
    for (const startMode of MODES) {
      it(`${presetId}${guided ? ` (${guided})` : ""} in ${startMode} mode`, async () => {
        classifyInstallation(localStorage, 1);
        useOnboardingStore.getState().load();
        await useOnboardingStore.getState().commitSetup({
          presetId,
          guidedChoice: guided,
          presentation: { startMode },
        });

        const expectedLevel = presetId === "strict" ? "strict" : "standard";
        expect(getCurrentLevel()).toBe(expectedLevel);

        const live = presetId === "recommended" || guided === "live-information";
        expect(canUse("operator.realtime")).toBe(live);
        expect(canUse("operator.service-alerts")).toBe(live);
        // Nothing else is granted by any preset.
        expect(canUse("external.detailed-basemap", "carto")).toBe(false);
        expect(canUse("operator.nearby-stop-centroid")).toBe(false);
        expect(canUse("operator.remote-routing")).toBe(false);
        expect(canUse("operator.transit-data")).toBe(true);

        // Presentation is independent of the privacy shortcut.
        expect(useSettingsStore.getState().scheduleMode).toBe(startMode === "text");

        const stored = record();
        expect(stored.applied).toBe(true);
        expect(stored.decisions?.preset).toBe(presetId);
        expect(stored.install.kind).toBe("new");

        const decisions = useNetworkDecisionsStore.getState().decisions;
        expect(Object.values(decisions).every((d) => d.source === "setup")).toBe(true);
        expect(matchOnboardingPreset(expectedLevel, decisions)).toBe(
          presetId === "recommended"
            ? "recommended"
            : presetId === "strict"
              ? "strict"
              : guided === "live-information"
                ? "recommended"
                : "custom",
        );
      });
    }
  }

  it("a new Strict installation does not run the decoy timer", async () => {
    classifyInstallation(localStorage, 1);
    await useOnboardingStore.getState().commitSetup({ presetId: "strict" });
    const { level, overrides } = usePrivacyStore.getState();
    expect(effectivePolicy(level, overrides).m11TileDefense).toBe("prefetch-padding");
  });

  it("a later level change leaves decisions untouched, and a decision leaves the level", async () => {
    classifyInstallation(localStorage, 1);
    await useOnboardingStore.getState().commitSetup({ presetId: "recommended" });
    const before = useNetworkDecisionsStore.getState().decisions;
    await usePrivacyStore.getState().setLevel("paranoid");
    await usePrivacyStore.getState().setLevel("baseline");
    expect(useNetworkDecisionsStore.getState().decisions).toBe(before);
    expect(canUse("operator.realtime")).toBe(true);

    useNetworkDecisionsStore.getState().setDecision("operator.realtime", "denied", "settings");
    expect(getCurrentLevel()).toBe("baseline");
  });

  it("the draft never activates anything before commit", () => {
    classifyInstallation(localStorage, 1);
    useOnboardingStore.getState().load();
    useOnboardingStore.getState().setDraftPreset("recommended");
    useOnboardingStore.getState().setDraftPresentation({ startMode: "text" });
    expect(canUse("operator.realtime")).toBe(false);
    expect(record().decisions).toBeNull();
    expect(useSettingsStore.getState().scheduleMode).toBe(false);
  });

  it("stores the What's new id shown at setup", async () => {
    classifyInstallation(localStorage, 1);
    await useOnboardingStore.getState().commitSetup({
      presetId: "strict",
      seenWhatsNew: 3,
    });
    expect(record().seenWhatsNew).toBe(3);
  });

  it("applies storage choices from the journal", async () => {
    classifyInstallation(localStorage, 1);
    await useOnboardingStore.getState().commitSetup({
      presetId: "recommended",
      storageChoices: { recents: "disabled" },
    });
    expect(usePrivacyChoicesStore.getState().choices.recents).toBe("disabled");
    expect(usePrivacyChoicesStore.getState().choices.viewport).toBe("unset");
  });

  it("keeps working on session state when storage refuses writes", async () => {
    classifyInstallation(localStorage, 1);
    useOnboardingStore.getState().load();
    const original = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error("quota");
    };
    try {
      const applied = await useOnboardingStore
        .getState()
        .commitSetup({ presetId: "recommended" });
      expect(applied.applied).toBe(true);
      expect(useOnboardingStore.getState().storageAvailable).toBe(false);
      expect(canUse("operator.realtime")).toBe(true);
    } finally {
      localStorage.setItem = original;
    }
  });
});

describe("journal recovery", () => {
  it("re-applies a committed journal interrupted before it reached the stores", async () => {
    classifyInstallation(localStorage, 1);
    const pending: OnboardingRecord = {
      ...record(),
      decisions: {
        preset: "recommended",
        level: "standard",
        flows: { "operator.realtime": { value: "allowed", source: "setup" } },
      },
      presentation: { startMode: "text" },
      applied: false,
    };
    writeOnboardingRecord(pending);
    await reload();
    expect(canUse("operator.realtime")).toBe(false);

    await applyPendingOnboardingJournal();
    expect(canUse("operator.realtime")).toBe(true);
    expect(useSettingsStore.getState().scheduleMode).toBe(true);
    expect(record().applied).toBe(true);

    // Applying again (another boot) changes nothing.
    useNetworkDecisionsStore
      .getState()
      .setDecision("operator.realtime", "denied", "settings");
    await applyPendingOnboardingJournal();
    expect(canUse("operator.realtime")).toBe(false);
  });

  it("survives a reload after commit: preference stores stay authoritative", async () => {
    classifyInstallation(localStorage, 1);
    await useOnboardingStore.getState().commitSetup({
      presetId: "recommended",
      presentation: { startMode: "text" },
    });
    useSettingsStore.getState().setScheduleMode(false);
    await reload();
    await applyPendingOnboardingJournal();
    expect(useSettingsStore.getState().scheduleMode).toBe(false);
    expect(canUse("operator.realtime")).toBe(true);
    expect(useOnboardingStore.getState().record?.applied).toBe(true);
  });
});

describe("legacy installations", () => {
  async function bootLegacy(state: Record<string, unknown>): Promise<void> {
    seed("ptn-privacy", state);
    classifyInstallation(localStorage, 1);
    await reload();
    await applyPendingOnboardingJournal();
  }

  it("keeps their level and previous network behavior", async () => {
    await bootLegacy({ level: "hardened", overrides: { urlShare: "disabled" } });
    expect(getCurrentLevel()).toBe("hardened");
    expect(canUse("operator.realtime")).toBe(true);
    expect(canUse("operator.service-alerts")).toBe(false);
    expect(useNetworkDecisionsStore.getState().decisions["operator.realtime"]?.source).toBe(
      "legacy",
    );
  });

  it("a legacy strict installation keeps the decoy timer as a carried-over override", async () => {
    await bootLegacy({ level: "strict", overrides: {} });
    const { level, overrides } = usePrivacyStore.getState();
    expect(level).toBe("strict");
    expect(effectivePolicy(level, overrides).m11TileDefense).toBe(
      "prefetch-padding-decoy",
    );
    expect(record().legacyOverrides).toEqual({ m11TileDefense: "prefetch-padding-decoy" });
  });

  it("lowering the level below strict removes the carried-over override for good", async () => {
    await bootLegacy({ level: "strict", overrides: {} });
    await usePrivacyStore.getState().setLevel("standard");
    expect(usePrivacyStore.getState().overrides.m11TileDefense).toBeUndefined();
    expect(record().legacyOverrides).toEqual({});

    // Next boot: classification and journal are done; nothing comes back.
    classifyInstallation(localStorage, 2);
    await reload();
    await applyPendingOnboardingJournal();
    expect(usePrivacyStore.getState().overrides.m11TileDefense).toBeUndefined();
  });

  it("raising the level keeps the carried-over override", async () => {
    await bootLegacy({ level: "strict", overrides: {} });
    await usePrivacyStore.getState().setLevel("paranoid");
    expect(record().legacyOverrides).toEqual({ m11TileDefense: "prefetch-padding-decoy" });
  });

  it("does not re-add a carried-over override the user removed", async () => {
    await bootLegacy({ level: "strict", overrides: {} });
    useOnboardingStore.getState().removeCarriedOverOverride("m11TileDefense");
    expect(usePrivacyStore.getState().overrides.m11TileDefense).toBeUndefined();

    classifyInstallation(localStorage, 2);
    await reload();
    await applyPendingOnboardingJournal();
    expect(usePrivacyStore.getState().overrides.m11TileDefense).toBeUndefined();
    expect(record().legacyOverrides).toEqual({});
  });

  it("the migration runs once even when the journal is applied repeatedly", async () => {
    await bootLegacy({ level: "standard", overrides: {} });
    useNetworkDecisionsStore.getState().setDecision("operator.realtime", "denied", "settings");
    classifyInstallation(localStorage, 3);
    await reload();
    await applyPendingOnboardingJournal();
    expect(canUse("operator.realtime")).toBe(false);
  });

  it("skips first-run setup", async () => {
    await bootLegacy({ level: "standard", overrides: {} });
    expect(localStorage.getItem(ONBOARDING_RECORD_KEY)).not.toBeNull();
    expect(useOnboardingStore.getState().record?.install.kind).toBe("existing");
  });
});

describe("cross-tab journal sync", () => {
  it("re-reads the record when another tab changes it", async () => {
    classifyInstallation(localStorage, 1);
    useOnboardingStore.getState().load();
    const stop = installPrivacyStateSync();
    try {
      const other = { ...record(), seenWhatsNew: 4 };
      localStorage.setItem(ONBOARDING_RECORD_KEY, JSON.stringify(other));
      window.dispatchEvent(new StorageEvent("storage", { key: ONBOARDING_RECORD_KEY }));
      expect(useOnboardingStore.getState().record?.seenWhatsNew).toBe(4);
    } finally {
      stop();
    }
  });
});
