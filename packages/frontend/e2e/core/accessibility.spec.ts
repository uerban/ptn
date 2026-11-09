// Automated accessibility checks for setup, Text mode, the map controls and
// the privacy settings: axe (WCAG 2.x A/AA, including target size), one main
// landmark, labelled groups, visible focus, reduced motion, status and error
// announcements, focus restoration, and no map promotion that takes focus or
// speaks through a live region. Screen-reader task testing stays manual.
import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mockApi } from "../helpers/mock-api";

// axe-core ships with jest-axe, already a dev dependency.
const AXE_PATH = createRequire(
  createRequire(import.meta.url).resolve("jest-axe"),
).resolve("axe-core/axe.min.js");

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[]; html: string; failureSummary?: string }[];
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            ctx: unknown,
            opts: unknown,
          ) => Promise<{ violations: AxeViolation[] }>;
        };
      }
    ).axe;
    const result = await axe.run(
      // The map canvas is a picture of the same data the lists carry.
      {
        exclude: [
          [".maplibregl-canvas-container"],
          [".maplibregl-ctrl-attrib"],
        ],
      },
      {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
        },
        resultTypes: ["violations"],
      },
    );
    return result.violations;
  });
  return violations.map(
    (v: AxeViolation) =>
      `${v.id} (${v.impact}): ${v.help} — ${v.nodes.map((n) => `${n.target.join(" ")} ${n.html.slice(0, 160)} [${n.failureSummary ?? ""}]`).join(", ")}`,
  );
}

test.describe("accessibility @mock-api", () => {
  test.use({ permissions: [] });

  test("setup screens pass axe, label their groups and show keyboard focus", async ({
    page,
  }) => {
    await mockApi(page, { setup: "fresh", realtime: "departures, alerts" });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Choose your city" }),
    ).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await expect(page.getByRole("main")).toHaveCount(1);

    await page.getByRole("button", { name: /^Vilnius/ }).click();
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "How would you like to plan and explore?",
      }),
    ).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await expect(
      page.getByRole("group", { name: "Starting view" }),
    ).toBeVisible();
    // The setup heading takes focus after a step change, for screen readers.
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();

    // Tab to the first control: its focus indicator is drawn.
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return {
        style: style.outlineStyle,
        width: style.outlineWidth,
        shadow: style.boxShadow,
      };
    });
    expect(outline).not.toBeNull();
    expect(
      (outline!.style !== "none" && outline!.width !== "0px") ||
        outline!.shadow !== "none",
    ).toBe(true);
  });

  test("Text mode home and the departure sheet pass axe and restore focus", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await mockApi(page, { realtime: "departures, alerts" });
    await page.addInitScript(() => {
      const settings = JSON.parse(localStorage.getItem("ptn-settings") || "{}");
      settings.state = { ...settings.state, scheduleMode: true };
      localStorage.setItem("ptn-settings", JSON.stringify(settings));
    });
    await page.goto("/");
    const textHome = page.locator("section[aria-label='Text mode']");
    await expect(textHome).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("main")).toHaveCount(1);
    const stop = page
      .getByRole("region", { name: "Nearby stops" })
      .getByRole("button")
      .first();
    await expect(stop).toBeVisible({ timeout: 15_000 });
    expect(await axeViolations(page)).toEqual([]);

    await stop.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByTestId("departure-sheet");
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(stop).toBeFocused();
  });

  test("privacy settings pass axe and label every choice", async ({ page }) => {
    await mockApi(page, { realtime: "departures, alerts" });
    await page.goto("/settings");
    const advanced = page.getByRole("button", { name: /^Advanced/ });
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await advanced.click();
    await expect(advanced).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("privacy-status")).toBeVisible();
    await expect(
      page.getByRole("group", { name: /Current setup/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("radiogroup", { name: "Protection level" }),
    ).toBeVisible();
    await expect(
      page.getByRole("radiogroup", {
        name: "Service alerts from the PTN operator",
      }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);
    expect(await axeViolations(page)).toEqual([]);
  });

  test("reduced motion stops animations and transitions", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockApi(page, { setup: "fresh" });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Choose your city" }),
    ).toBeVisible();
    const long = await page.evaluate(
      () =>
        document.getAnimations().filter((a) => {
          const timing = a.effect?.getComputedTiming();
          return (
            typeof timing?.duration === "number" &&
            timing.duration > 1 &&
            timing.iterations !== 1
          );
        }).length,
    );
    expect(long).toBe(0);
    const transition = await page
      .getByRole("button", { name: /^Vilnius/ })
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(transition.split(",").every((d) => parseFloat(d) <= 0.001)).toBe(
      true,
    );
  });
});

test.describe("translated labels and large text @mock-api", () => {
  // Finnish and Estonian have the longest words among the shipped locales.
  for (const locale of ["fi-FI", "et-EE"]) {
    test.describe(locale, () => {
      test.use({
        locale,
        permissions: [],
        viewport: { width: 360, height: 740 },
      });

      async function enlargeText(page: Page): Promise<void> {
        await page.addInitScript(() => {
          document.addEventListener("DOMContentLoaded", () => {
            document.documentElement.style.fontSize = "200%";
          });
        });
      }

      const overflow = (page: Page) =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );

      test("setup wraps at 200% text without horizontal scrolling", async ({
        page,
      }) => {
        await mockApi(page, { setup: "fresh" });
        await enlargeText(page);
        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(1);
        await page.getByRole("button", { name: /^Vilnius/ }).click();
        await expect(page.getByRole("group").first()).toBeVisible();
        await page.waitForTimeout(300);
        expect(await overflow(page)).toBeLessThanOrEqual(1);
      });

      test("privacy settings wrap at 200% text without horizontal scrolling", async ({
        page,
      }) => {
        await mockApi(page);
        await enlargeText(page);
        await page.goto("/settings");
        await page.getByRole("button", { expanded: false }).last().click();
        await expect(page.getByTestId("privacy-status")).toBeVisible();
        await page.waitForTimeout(300);
        expect(await overflow(page)).toBeLessThanOrEqual(1);
      });
    });
  }
});

test.describe("settings fit a narrow phone @mock-api", () => {
  // Belarusian and Finnish carry the longest settings labels; English is the
  // baseline. Switches and the mobility-profile buttons used to push past the
  // right edge and scroll the whole app sideways.
  for (const locale of ["en-US", "be-BY", "fi-FI"]) {
    test.describe(locale, () => {
      test.use({ locale, viewport: { width: 360, height: 740 } });
      test("nothing reaches past the right edge", async ({ page }) => {
        await mockApi(page);
        await page.goto("/settings");
        await expect(page.getByRole("switch").first()).toBeVisible();
        await page.waitForTimeout(300);
        const report = await page.evaluate(() => {
          const width = document.documentElement.clientWidth;
          const offenders = [
            ...document.querySelectorAll<HTMLElement>(
              '[role="switch"], [role="group"] button, input[type="range"]',
            ),
          ]
            .filter((el) => el.getBoundingClientRect().right > width + 1)
            .map(
              (el) =>
                el.getAttribute("aria-labelledby") ??
                el.dataset.testid ??
                el.textContent?.trim(),
            );
          return {
            overflow: document.documentElement.scrollWidth - width,
            offenders,
          };
        });
        expect(report.offenders).toEqual([]);
        expect(report.overflow).toBeLessThanOrEqual(1);
      });
    });
  }
});
