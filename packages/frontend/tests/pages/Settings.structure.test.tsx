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

const headings = () =>
  screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.trim());

describe("Settings structure", () => {
  it("groups the main list: look, map, trips, search, offline, data", async () => {
    renderSettings();
    await screen.findByRole("heading", { level: 2, name: "Delete data" });
    const order = ["Language", "Theme", "Appearance", "GPS location", "Map", "Display", "Trips",
      "Trip routing", "Trip alerts", "Search", "Places in search", "Privacy", "Delete data", "About"];
    const seen = headings().filter((h): h is string => !!h && order.includes(h));
    expect(seen).toEqual(order);
  });

  it("has no Routing Engine choice", async () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    await screen.findByRole("heading", { level: 2, name: "Network services" });
    expect(screen.queryByText("Routing Engine")).not.toBeInTheDocument();
  });

  it("keeps everything about recent places in one card", async () => {
    renderSettings();
    const card = await screen.findByRole("region", { name: "Recent places" });
    expect(within(card).getByRole("button", { name: "Purge" })).toBeInTheDocument();
    expect(within(card).getByRole("radio", { name: "Encrypted at rest" })).toBeInTheDocument();
    // …and not again among the per-axis overrides or as its own section.
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    await screen.findByRole("heading", { level: 2, name: "Per-axis overrides" });
    expect(document.querySelectorAll('[data-axis-group="recentsEncryption"]')).toHaveLength(1);
    expect(screen.queryByRole("heading", { level: 2, name: "Recent locations" })).not.toBeInTheDocument();
  });
});
