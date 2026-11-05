import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { axe } from "jest-axe";
import { BrowserRouter } from "react-router-dom";
import { SettingsPage } from "../../src/pages/Settings.tsx";
import { I18nProvider } from "../../src/i18n/I18nProvider.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";

const PROFILES = ["default", "wheelchair", "vision_impaired", "bicycle"] as const;

// Every conditional block open: urban lookahead, card layout, the pre-stop
// buffer slider and the advanced sections.
function renderEverything(profile: (typeof PROFILES)[number]) {
  useSettingsStore.setState({
    mobilityProfile: profile,
    walkSpeedMps: 1.25,
    maxWalkSecs: 900,
    urbanMode: true,
    etaCardsEnabled: true,
    leaveBufferOverrideSeconds: 300,
  } as never);
  const view = render(
    <BrowserRouter>
      <I18nProvider>
        <SettingsPage />
      </I18nProvider>
    </BrowserRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
  return view;
}

describe("Settings — every control has an accessible name", () => {
  beforeEach(() => {
    useSettingsStore.setState({ mobilityProfile: "default" } as never);
  });

  for (const profile of PROFILES) {
    it(`has no axe violations under the ${profile} profile`, async () => {
      const { container } = renderEverything(profile);
      expect(await axe(container)).toHaveNoViolations();
    });
  }

  it("names each switch after its visible title and describes it with its hint", () => {
    renderEverything("default");
    const switches: [string, RegExp][] = [
      ["Schedule-only mode", /Text-based view without map/],
      ["Nearby departures cards", /next departures near you/],
      ["Center on my location at startup", /Fly to your GPS location/],
      ["Run to catch", /running pace/],
      ["Get-off alarm", /approaching your destination stop/],
      ["Trip notifications", /browser notifications/],
    ];
    for (const [name, description] of switches) {
      expect(screen.getByRole("switch", { name })).toHaveAccessibleDescription(description);
    }
    expect(screen.getByRole("switch", { name: "Use profile default" })).toBeInTheDocument();
  });

  it("names each slider and speaks its value in the unit the label shows", () => {
    renderEverything("default");
    expect(screen.getByRole("slider", { name: "Walking speed" })).toHaveAttribute("aria-valuetext", "4.5 km/h");
    // Seconds underneath; minutes on screen and in speech.
    expect(screen.getByRole("slider", { name: "Max walking time" })).toHaveAttribute("aria-valuetext", "15 min");
    expect(screen.getByRole("slider", { name: "Pre-stop buffer" })).toHaveAttribute("aria-valuetext", "5 min");
  });

  it("keeps the wheelchair hint as the walking-speed description", () => {
    renderEverything("wheelchair");
    expect(screen.getByRole("slider", { name: "Walking speed" })).toHaveAccessibleDescription(/wheelchair/i);
  });

  it("exposes which mobility profile is chosen", () => {
    renderEverything("default");
    const group = screen.getByRole("group", { name: "Mobility profile" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Default", pressed: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Vision impaired" }));
    expect(screen.getByRole("button", { name: "Vision impaired", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Default", pressed: false })).toBeInTheDocument();
  });
});
