import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { isAllowedBeforeSetup } from "../../src/setup/bootstrapRequests.ts";

// A fresh profile must never be prompted for location by setup itself.
test.use({ permissions: [] });

const SETUP_HEADING = "How would you like to plan and explore?";

async function readStorage(page: Page, key: string): Promise<unknown> {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key);
}

async function chooseCity(page: Page, name = "Vilnius") {
  await expect(page.getByRole("heading", { name: "Choose your city" })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("heading", { name: SETUP_HEADING })).toBeVisible();
}

async function expectInApp(page: Page) {
  await expect(page.getByTestId("setup-shell")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
}

test.describe("first-run setup @mock-api", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page, { setup: "fresh" });
  });

  test("a new profile chooses a city and starts with one preset action", async ({ page }) => {
    const requests: string[] = [];
    const record = (request: { url: () => string }) => requests.push(request.url());
    page.on("request", record);

    await page.goto("/");
    await expect(page.getByLabel("Find a city")).toBeVisible();
    // Map is the disclosed initial selection; Text comes first.
    await chooseCity(page);
    const modes = page.getByRole("radio");
    await expect(modes.first()).toHaveAccessibleName(/Text mode/);
    await expect(page.getByRole("radio", { name: /Map mode/ })).toBeChecked();
    await expect(page.getByText("You can change every choice in Settings", { exact: false })).toBeVisible();

    // Nothing optional, external or map-only before the choice.
    page.off("request", record);
    const origin = new URL(page.url()).origin;
    const disallowed = requests.filter((url) => !isAllowedBeforeSetup(url, origin));
    expect(disallowed, "requests made before setup completed").toEqual([]);
    expect(requests.some((url) => /\/gtfs\/manifest$/.test(url))).toBe(true);

    await page.getByRole("radio", { name: /Text mode/ }).check();
    await page.getByRole("button", { name: "Start with recommended settings" }).click();
    await expectInApp(page);

    const onboarding = (await readStorage(page, "ptn-onboarding")) as {
      decisions: { preset: string; level: string };
      presentation: { startMode: string };
      applied: boolean;
      seenWhatsNew: number;
    };
    expect(onboarding.decisions.preset).toBe("recommended");
    expect(onboarding.decisions.level).toBe("standard");
    expect(onboarding.presentation.startMode).toBe("text");
    expect(onboarding.applied).toBe(true);
    expect(onboarding.seenWhatsNew).toBeGreaterThan(0);
    const decisions = (await readStorage(page, "ptn-network-decisions")) as {
      state: { decisions: Record<string, { value: string }> };
    };
    expect(decisions.state.decisions["operator.realtime"]?.value).toBe("allowed");
    const settings = (await readStorage(page, "ptn-settings")) as {
      state: { scheduleMode: boolean; mapDetailMode: string };
    };
    expect(settings.state.scheduleMode).toBe(true);
    expect(settings.state.mapDetailMode).toBe("micromap");

    // Completed setup is not shown again.
    await page.reload();
    await expectInApp(page);
  });

  test("strict privacy keeps the chosen presentation and grants nothing", async ({ page }) => {
    await page.goto("/");
    await chooseCity(page);
    await page.getByText("What strict privacy changes").click();
    await expect(page.getByText("History is kept for 7 days.")).toBeVisible();
    await page.getByRole("button", { name: "Start with strict privacy" }).click();
    await expectInApp(page);
    const privacy = (await readStorage(page, "ptn-privacy")) as { state: { level: string } };
    expect(privacy.state.level).toBe("strict");
    const decisions = (await readStorage(page, "ptn-network-decisions")) as {
      state: { decisions: Record<string, unknown> };
    } | null;
    expect(decisions?.state.decisions ?? {}).toEqual({});
    const settings = (await readStorage(page, "ptn-settings")) as { state: { scheduleMode: boolean } };
    expect(settings.state.scheduleMode).toBe(false);
  });

  test("customize asks the network question and writes only its answer", async ({ page }) => {
    await page.goto("/");
    await chooseCity(page);
    await page.getByRole("button", { name: "Customize" }).click();
    const proceed = page.getByRole("button", { name: "Continue" });
    await expect(proceed).toBeDisabled();
    await page.getByRole("radio", { name: /Ask before connecting/ }).check();
    await proceed.click();
    await expectInApp(page);
    // `standard` is the default level, so it may not be written at all.
    const privacy = (await readStorage(page, "ptn-privacy")) as { state: { level: string } } | null;
    expect(privacy?.state.level ?? "standard").toBe("standard");
    const decisions = (await readStorage(page, "ptn-network-decisions")) as {
      state: { decisions: Record<string, unknown> };
    } | null;
    expect(decisions?.state.decisions ?? {}).toEqual({});
  });

  test("back, reload and resume keep setup progress without activating anything", async ({ page }) => {
    await page.goto("/");
    await chooseCity(page);
    await page.getByRole("radio", { name: /Text mode/ }).check();

    await page.reload();
    await expect(page.getByRole("heading", { name: SETUP_HEADING })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Text mode/ })).toBeChecked();
    expect(await readStorage(page, "ptn-network-decisions")).toBeNull();
    const pending = (await readStorage(page, "ptn-onboarding")) as { decisions: unknown };
    expect(pending.decisions).toBeNull();

    await page.goBack();
    await expect(page.getByRole("heading", { name: "Choose your city" })).toBeVisible();
    await chooseCity(page);
    await page.getByRole("button", { name: "Change city" }).click();
    await expect(page.getByRole("heading", { name: "Choose your city" })).toBeVisible();
  });

  test("a language chosen before setup applies, and setup still shows after reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /More languages/ }).click();
    await page.getByRole("radio", { name: "Lietuvių" }).check();
    await page.reload();
    await expect(page.getByTestId("setup-shell")).toBeVisible();
    await expect(page.getByRole("radio", { name: "Lietuvių" })).toBeChecked();
    const onboarding = (await readStorage(page, "ptn-onboarding")) as { decisions: unknown };
    expect(onboarding.decisions).toBeNull();
  });

  test("a stored city alone is preselected but setup still runs", async ({ page }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem("ptn-onboarding")) {
        localStorage.setItem("ptn-city", JSON.stringify({ state: { activeCity: { id: "vilnius" } }, version: 0 }));
      }
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: SETUP_HEADING })).toBeVisible();
    await expect(page.getByText("City: Vilnius")).toBeVisible();
  });

  test("corrupted setup storage runs setup again instead of guessing", async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem("ptn-onboarding", "{not json");
        localStorage.setItem("ptn-settings", JSON.stringify({ state: { scheduleMode: false }, version: 0 }));
      }
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Choose your city" })).toBeVisible();
  });

  test("a deep link survives setup and grants nothing by itself", async ({ page }) => {
    await page.goto("/search?toLat=54.6872&toLon=25.2797&toName=Cathedral");
    await expect(page.getByText("Choose a city to open the link you followed", { exact: false })).toBeVisible();
    await chooseCity(page);
    await expect(page.getByText("The link you followed opens after this step.")).toBeVisible();
    await page.getByRole("button", { name: "Start with strict privacy" }).click();
    await expect(page).toHaveURL(/\/search\?toLat=54\.6872&toLon=25\.2797&toName=Cathedral$/);
    await expect(page.getByTestId("setup-shell")).toHaveCount(0);
    const decisions = (await readStorage(page, "ptn-network-decisions")) as {
      state: { decisions: Record<string, unknown> };
    } | null;
    expect(decisions?.state.decisions ?? {}).toEqual({});
  });

  test("offline without transit data offers a clear next step", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "onLine", { get: () => false });
    });
    await page.goto("/");
    await expect(page.getByText("No connection. Only cities whose transit data", { exact: false })).toBeVisible();
    const vilnius = page.getByRole("button", { name: /^Vilnius/ });
    await expect(vilnius).toBeDisabled();
    await expect(vilnius).toContainText("Needs a connection to download");
  });
});

test.describe("existing installations @mock-api", () => {
  test("skip first-run setup and keep What's new unseen", async ({ page }) => {
    await mockApi(page, { setup: "fresh" });
    await page.addInitScript(() => {
      if (!localStorage.getItem("ptn-onboarding")) {
        localStorage.setItem("ptn-city", JSON.stringify({ state: { activeCity: { id: "vilnius" } }, version: 0 }));
        localStorage.setItem("ptn-settings", JSON.stringify({ state: { scheduleMode: false }, version: 0 }));
      }
    });
    await page.goto("/");
    await expectInApp(page);
    const onboarding = (await readStorage(page, "ptn-onboarding")) as {
      install: { kind: string };
      legacyMigrated: boolean;
      applied: boolean;
      seenWhatsNew: number;
    };
    expect(onboarding.install.kind).toBe("existing");
    expect(onboarding.legacyMigrated).toBe(true);
    expect(onboarding.applied).toBe(true);
    expect(onboarding.seenWhatsNew).toBe(0);
  });

  test("a completed setup without a usable city asks for the city only", async ({ page }) => {
    await mockApi(page, { setup: "fresh" });
    await page.addInitScript(() => {
      if (!localStorage.getItem("ptn-onboarding")) {
        localStorage.setItem("ptn-settings", JSON.stringify({ state: { scheduleMode: true }, version: 0 }));
      }
    });
    await page.goto("/");
    await page.getByRole("button", { name: /^Vilnius/ }).click();
    await expectInApp(page);
    const settings = (await readStorage(page, "ptn-settings")) as { state: { scheduleMode: boolean } };
    expect(settings.state.scheduleMode).toBe(true);
  });
});
