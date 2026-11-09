import type { Page } from "@playwright/test";
// Relative into the frontend source (no browser APIs at module scope), so the
// seeded record stays in step with the build's What's new entries.
import { LATEST_WHATS_NEW_ID } from "../../src/services/whatsNew.ts";

/**
 * Seed a profile that already finished first-run setup, so a spec starts in
 * the app instead of the setup shell.
 *
 * Writes the onboarding record (setup committed and applied, What's new
 * caught up) and, unless told otherwise, the decisions the Recommended
 * preset grants. Both are written only when absent, so a spec that reloads
 * keeps what the app stored, and a spec can seed its own state first.
 *
 * A spec that seeds earlier app state (`ptn-settings`, `ptn-privacy`, …)
 * models an existing installation: nothing is written for it, and the app's
 * own installation classifier carries its settings over and skips setup,
 * exactly as it does for a real upgrade. The check runs after every init
 * script (when parsing ends, before the app's module scripts), so it sees
 * state seeded by scripts registered after this one.
 *
 * MUST be called before `page.goto(...)`.
 */
export interface CompletedSetupOptions {
  /** Network decisions to seed. Defaults to the Recommended grants;
   * pass `{}` for a profile with every optional flow unset. */
  readonly decisions?: Record<string, "allowed" | "denied">;
  /** Also select this city when no city is stored yet. */
  readonly cityId?: string;
  /** Mark the one-time detailed-maps question as answered (default), so its
   * dialog does not cover the map. Pass `false` to see the question. */
  readonly mapDetailAsked?: boolean;
}

export const RECOMMENDED_DECISIONS: Readonly<Record<string, "allowed">> = {
  "operator.realtime": "allowed",
  "operator.service-alerts": "allowed",
};

export async function seedCompletedSetup(
  page: Page,
  options: CompletedSetupOptions = {},
): Promise<void> {
  const record = {
    version: 1,
    install: { kind: "new" },
    decisions: { preset: "recommended", level: null, flows: {} },
    presentation: null,
    applied: true,
    legacyOverrides: {},
    seenWhatsNew: LATEST_WHATS_NEW_ID,
    alertsNotNow: 0,
  };
  const decisions = Object.fromEntries(
    Object.entries(options.decisions ?? RECOMMENDED_DECISIONS).map(([flow, value]) => [
      flow,
      { value, source: "setup", decidedAt: 1 },
    ]),
  );
  const cityId = options.cityId ?? null;
  const mapDetailAsked = options.mapDetailAsked ?? true;
  await page.addInitScript(
    ({ record, decisions, cityId, mapDetailAsked }) => {
      if (cityId && !localStorage.getItem("ptn-city")) {
        localStorage.setItem(
          "ptn-city",
          JSON.stringify({ state: { activeCity: { id: cityId } }, version: 0 }),
        );
      }
      const seed = () => {
        // Independent of the setup record: an installation a spec models as
        // existing still must not open the question over the map.
        if (mapDetailAsked && !localStorage.getItem("ptn-map-detail-asked")) {
          localStorage.setItem("ptn-map-detail-asked", "1");
        }
        if (localStorage.getItem("ptn-onboarding")) return;
        const existing = [
          "ptn-settings",
          "ptn-privacy",
          "ptn-privacy-choices",
          "ptn-favorites",
          "ptn-privacy-data-migration",
        ].some((key) => localStorage.getItem(key) !== null);
        if (existing) return;
        localStorage.setItem("ptn-onboarding", JSON.stringify(record));
        if (!localStorage.getItem("ptn-network-decisions")) {
          localStorage.setItem(
            "ptn-network-decisions",
            JSON.stringify({ state: { decisions }, version: 1 }),
          );
        }
      };
      if (document.readyState === "loading") {
        document.addEventListener("readystatechange", seed, { once: true });
      } else {
        seed();
      }
    },
    { record, decisions, cityId, mapDetailAsked },
  );
}

/**
 * Record network decisions as if the user had made them in Settings, merged
 * over whatever the profile already stores.
 *
 * Only for a profile whose setup is already applied (a new installation, or
 * one seeded by `seedCompletedSetup`). An existing installation that the app
 * still has to classify (a spec that seeds `ptn-privacy`, `ptn-settings`, …,
 * such as `bootAtPrivacyLevel`) applies its setup journal at boot, and the
 * journal replaces every decision: use `decideAfterSetup` there.
 *
 * MUST be called before `page.goto(...)`.
 */
export async function seedNetworkDecisions(
  page: Page,
  decisions: Record<string, "allowed" | "denied">,
): Promise<void> {
  await page.addInitScript((decisions) => {
    const key = "ptn-network-decisions";
    let stored: { state?: { decisions?: Record<string, unknown> }; version?: number } = {};
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? "{}");
    } catch {
      stored = {};
    }
    const merged: Record<string, unknown> = { ...(stored.state?.decisions ?? {}) };
    for (const [flow, value] of Object.entries(decisions)) {
      merged[flow] = { value, source: "settings", decidedAt: 1 };
    }
    localStorage.setItem(
      key,
      JSON.stringify({ state: { decisions: merged }, version: stored.version ?? 1 }),
    );
  }, decisions);
}

const NETWORK_DECISIONS_MODULE = "/src/stores/networkDecisionsStore.ts";

/**
 * Record network decisions in the running app, as the user would in
 * Settings, once the setup journal has been applied (so the journal cannot
 * replace them). Works for every profile, including an existing installation
 * the app classified at boot. Needs the dev server, which serves the store
 * module by its source path.
 *
 * MUST be called after `page.goto(...)`.
 */
export async function decideAfterSetup(
  page: Page,
  decisions: Record<string, "allowed" | "denied">,
): Promise<void> {
  await page.waitForFunction(() => {
    try {
      const record = JSON.parse(localStorage.getItem("ptn-onboarding") ?? "null") as {
        applied?: unknown;
      } | null;
      return record?.applied === true;
    } catch {
      return false;
    }
  });
  await page.evaluate(
    async ({ decisions, modulePath }) => {
      const mod = (await import(/* @vite-ignore */ modulePath)) as {
        useNetworkDecisionsStore: {
          getState: () => {
            setDecision: (
              flowId: string,
              value: string,
              source: string,
              providerId?: string,
            ) => boolean;
          };
        };
      };
      for (const [key, value] of Object.entries(decisions)) {
        const [flowId, providerId] = key.split("@");
        const stored = mod.useNetworkDecisionsStore
          .getState()
          .setDecision(flowId!, value, "settings", providerId);
        if (!stored) throw new Error(`Cannot record a decision for ${key}`);
      }
    },
    { decisions, modulePath: NETWORK_DECISIONS_MODULE },
  );
}
