import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BrowserRouter } from "react-router-dom";
import { SettingsPage } from "../../src/pages/Settings.tsx";
import { I18nProvider } from "../../src/i18n/I18nProvider.tsx";

function renderSettings() {
  return render(
    <BrowserRouter>
      <I18nProvider>
        <SettingsPage />
      </I18nProvider>
    </BrowserRouter>,
  );
}

// Several sections are lazy chunks and the privacy strings load on demand.
// The first render on a cold, busy runner can take longer than the default
// 1 s that findBy* waits, so give those waits (and the tests) more room.
const LAZY = { timeout: 10_000 };
const TEST_TIMEOUT = 20_000;

const headings = () =>
  screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.trim());

describe("Settings structure", () => {
  it("groups the main list: look, map, trips, search, offline, data", async () => {
    renderSettings();
    await screen.findByRole("heading", { level: 2, name: "Delete data" }, LAZY);
    const order = ["Language", "Theme", "Appearance", "GPS location", "Map", "Display", "Trips",
      "Trip routing", "Trip alerts", "Search", "Places in search", "Privacy", "Delete data", "About"];
    const seen = headings().filter((h): h is string => !!h && order.includes(h));
    expect(seen).toEqual(order);
  }, TEST_TIMEOUT);

  it("has no Routing Engine choice", async () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    await screen.findByRole("heading", { level: 2, name: "Network services" }, LAZY);
    expect(screen.queryByText("Routing Engine")).not.toBeInTheDocument();
  }, TEST_TIMEOUT);

  it("keeps everything about recent places in one card", async () => {
    renderSettings();
    const card = await screen.findByRole("region", { name: "Recent places" }, LAZY);
    expect(within(card).getByRole("button", { name: "Purge" })).toBeInTheDocument();
    expect(await within(card).findByRole("radio", { name: "Encrypted at rest" }, LAZY)).toBeInTheDocument();
    // …and not again among the per-axis overrides or as its own section.
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    await screen.findByRole("heading", { level: 2, name: "Per-axis overrides" }, LAZY);
    expect(document.querySelectorAll('[data-axis-group="recentsEncryption"]')).toHaveLength(1);
    expect(screen.queryByRole("heading", { level: 2, name: "Recent locations" })).not.toBeInTheDocument();
  }, TEST_TIMEOUT);
});
