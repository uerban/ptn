import { describe, expect, test } from "vitest";
import {
  LEVEL_FLOORS,
  PRIVACY_LEVELS,
  type PrivacyLevel,
  type PrivacyPolicy,
} from "@pt/shared/privacy";
import {
  loadLocale,
  loadPrivacyNamespace,
  SUPPORTED_LOCALES,
} from "./index.ts";
import enPrivacy from "./privacy.json";

describe("privacy i18n namespace", () => {
  test("every privacy key begins with 'privacy.'", () => {
    const keys = Object.keys(enPrivacy);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith("privacy.")).toBe(true);
    }
  });

  test("every level has a name and description", () => {
    for (const level of PRIVACY_LEVELS) {
      expect(enPrivacy).toHaveProperty(`privacy.level.${level}.name`);
      expect(enPrivacy).toHaveProperty(`privacy.level.${level}.description`);
    }
  });

  test("every PrivacyPolicy axis has a title and lockedCopy", () => {
    const axes = Object.keys(LEVEL_FLOORS.baseline) as Array<keyof PrivacyPolicy>;
    for (const axis of axes) {
      expect(enPrivacy).toHaveProperty(`privacy.axis.${axis}.title`);
      expect(enPrivacy).toHaveProperty(`privacy.axis.${axis}.lockedCopy`);
    }
  });

  test("lockedCopy template contains the three placeholders", () => {
    const axes = Object.keys(LEVEL_FLOORS.baseline) as Array<keyof PrivacyPolicy>;
    for (const axis of axes) {
      const copy = (enPrivacy as Record<string, string>)[
        `privacy.axis.${axis}.lockedCopy`
      ];
      expect(copy).toMatch(/\{value\}/);
      expect(copy).toMatch(/\{level\}/);
      expect(copy).toMatch(/\{minLevel\}/);
    }
  });

  test("enum axis values all have option.<value> copy", () => {
    // recentsEncryption is an enum axis used as a canary — make sure its
    // option keys exist.
    const options: Array<PrivacyPolicy["recentsEncryption"]> = [
      "encrypted",
      "encrypted-30d",
      "encrypted-7d",
      "ram-only",
      "off",
    ];
    for (const opt of options) {
      expect(enPrivacy).toHaveProperty(
        `privacy.axis.recentsEncryption.option.${opt}`,
      );
    }
  });

  test("no option offers storing personal data unencrypted", () => {
    for (const key of [
      "privacy.axis.recentsEncryption.option.plaintext",
      "privacy.axis.savesEncryption.option.opt-in",
      "privacy.axis.savesEncryption.option.default",
    ]) {
      expect(enPrivacy).not.toHaveProperty(key);
    }
  });

  test("encryption copy does not overstate protection", () => {
    const storageCopy = Object.entries(enPrivacy as Record<string, string>)
      .filter(([k]) => k.startsWith("privacy.storage.") || k === "privacy.disclosure.installKey")
      .map(([, v]) => v);
    expect(storageCopy.length).toBeGreaterThan(5);
    for (const copy of storageCopy) {
      expect(copy).not.toMatch(/\b(secure|safe|vault|locked)\b/i);
    }
    expect(enPrivacy).toHaveProperty(
      "privacy.storage.encryptedShort",
      "Saved places and history are encrypted on this device.",
    );
    expect(enPrivacy).toHaveProperty(
      "privacy.storage.encryptedDetail",
      "This makes them hard to read by looking through the browser's stored data. Anyone who can use this browser profile can still open the app and see them, so delete them if you share this device.",
    );
  });

  test("Privacy Center enum axes have copy for every option", () => {
    const options: {
      [K in
        | "basemapMode"
        | "nearbyStopLookup"
        | "viewportPersistence"
        | "stopUsageRetention"]: readonly PrivacyPolicy[K][];
    } = {
      basemapMode: ["external-detailed", "local-only"],
      nearbyStopLookup: ["centroid-server", "local-only"],
      viewportPersistence: [
        "raw",
        "snap-centroid",
        "rounded-50m",
        "rounded-100m",
        "off",
      ],
      stopUsageRetention: ["30d", "7d", "off"],
    };

    for (const [axis, values] of Object.entries(options)) {
      for (const value of values) {
        expect(enPrivacy).toHaveProperty(
          `privacy.axis.${axis}.option.${String(value)}`,
        );
      }
    }
  });

  test("nine threat-model disclosures exist", () => {
    const disclosures = [
      "atRest",
      "installKey",
      "mapTap",
      "urlShare",
      "providerFallback",
      "transitousProvider",
      "errorReporting",
      "realTimePolling",
      "m10DedupCache",
      "m11Tiles",
    ];
    for (const item of disclosures) {
      expect(enPrivacy).toHaveProperty(`privacy.disclosure.${item}`);
    }
    expect(disclosures.length).toBe(10);
  });

  test("at-rest copy makes no absolute no-egress claim", () => {
    const copy = enPrivacy["privacy.disclosure.atRest"];
    expect(copy).not.toMatch(/no data leaves.*unless.*(?:export|share)/i);
    expect(copy).toMatch(/operator/i);
    expect(copy).toMatch(/map, search, and routing providers/i);
  });

  // The privacy namespace is no longer merged into loadLocale — it is ~6 kB
  // gzipped of mostly-English prose whose only consumers sit behind the
  // Settings/Privacy lazy boundary. loadLocale must stay base-only so it is
  // not paid by every user at boot; loadPrivacyNamespace is fetched on demand.
  test("loadLocale does not carry the privacy namespace", async () => {
    for (const locale of SUPPORTED_LOCALES) {
      const base = await loadLocale(locale);
      const privacyKeys = Object.keys(base).filter((k) =>
        k.startsWith("privacy."),
      );
      expect(privacyKeys, `${locale} leaked privacy keys`).toEqual([]);
    }
  });

  test("loadPrivacyNamespace resolves privacy keys for every supported locale", async () => {
    for (const locale of SUPPORTED_LOCALES) {
      const ns = await loadPrivacyNamespace(locale);
      for (const level of PRIVACY_LEVELS as readonly PrivacyLevel[]) {
        expect(ns[`privacy.level.${level}.name`]).toBeTruthy();
      }
      expect(ns["privacy.disclosure.atRest"]).toBeTruthy();
    }
  });

  test("loadLocale preserves base locale keys too", async () => {
    const en = await loadLocale("en");
    expect(en["nav.map"]).toBeTruthy();
    const enPrivacyNs = await loadPrivacyNamespace("en");
    expect(enPrivacyNs["privacy.level.paranoid.name"]).toBeTruthy();
  });
});
