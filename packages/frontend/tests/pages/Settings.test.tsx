import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BrowserRouter } from "react-router-dom";
import { SettingsPage } from "../../src/pages/Settings.tsx";
import { I18nProvider } from "../../src/i18n/I18nProvider.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";

function renderSettings() {
  return render(
    <BrowserRouter>
      <I18nProvider>
        <SettingsPage />
      </I18nProvider>
    </BrowserRouter>,
  );
}

describe("Settings — pre-stop buffer", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      leaveBufferOverrideSeconds: null,
      mobilityProfile: "default",
    } as never);
  });

  it("renders 'Use profile default' toggle, on by default", () => {
    const { getByLabelText } = renderSettings();
    const sw = getByLabelText(/Use profile default/i);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("turning toggle off reveals slider; setting it persists override", () => {
    const { getByLabelText, getByRole } = renderSettings();
    fireEvent.click(getByLabelText(/Use profile default/i));
    const slider = getByRole("slider", { name: /Pre-stop buffer/i });
    fireEvent.change(slider, { target: { value: "240" } });
    expect(useSettingsStore.getState().leaveBufferOverrideSeconds).toBe(240);
  });

  it("turning toggle back on resets override to null", () => {
    useSettingsStore.setState({
      leaveBufferOverrideSeconds: 240,
      mobilityProfile: "default",
    } as never);
    const { getByLabelText } = renderSettings();
    fireEvent.click(getByLabelText(/Use profile default/i));
    expect(useSettingsStore.getState().leaveBufferOverrideSeconds).toBeNull();
  });

  it("shows resolved profile default minutes when toggle is on", () => {
    useSettingsStore.setState({
      leaveBufferOverrideSeconds: null,
      mobilityProfile: "wheelchair",
    } as never);
    const { getByText } = renderSettings();
    // wheelchair profile default = 300s = 5 min
    expect(
      getByText(/Using profile default \(5 min\)/i),
    ).toBeInTheDocument();
  });
});

describe("Settings — nearby departures cards layout", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      etaCardsEnabled: true,
      etaCardsLayout: "rows",
    } as never);
  });

  // The store's own default (`rows`) is pinned in settingsStore.etaLayout.test.ts.
  it("shows a two-option layout control with the stored layout selected", () => {
    const { getByRole, unmount } = renderSettings();
    const group = getByRole("radiogroup", { name: /Cards layout/i });
    expect(group).toBeInTheDocument();
    expect(getByRole("radio", { name: "Rows" })).toBeChecked();
    expect(getByRole("radio", { name: "Columns" })).not.toBeChecked();
    unmount();

    useSettingsStore.setState({ etaCardsLayout: "columns" } as never);
    const again = renderSettings();
    expect(again.getByRole("radio", { name: "Columns" })).toBeChecked();
    expect(again.getByRole("radio", { name: "Rows" })).not.toBeChecked();
  });

  it("switching the control updates the stored layout", () => {
    const { getByRole } = renderSettings();
    fireEvent.click(getByRole("radio", { name: "Columns" }));
    expect(useSettingsStore.getState().etaCardsLayout).toBe("columns");
    expect(getByRole("radio", { name: "Columns" })).toBeChecked();
    fireEvent.click(getByRole("radio", { name: "Rows" }));
    expect(useSettingsStore.getState().etaCardsLayout).toBe("rows");
  });

  it("is hidden while the cards are turned off", () => {
    useSettingsStore.setState({ etaCardsEnabled: false } as never);
    const { queryByRole } = renderSettings();
    expect(queryByRole("radiogroup", { name: /Cards layout/i })).toBeNull();
    expect(queryByRole("radio", { name: "Columns" })).toBeNull();
  });

  it("appears and disappears with the cards toggle", () => {
    const { queryByRole } = renderSettings();
    expect(queryByRole("radiogroup", { name: /Cards layout/i })).not.toBeNull();
    act(() => useSettingsStore.getState().setEtaCardsEnabled(false));
    expect(queryByRole("radiogroup", { name: /Cards layout/i })).toBeNull();
    act(() => useSettingsStore.getState().setEtaCardsEnabled(true));
    expect(queryByRole("radiogroup", { name: /Cards layout/i })).not.toBeNull();
  });
});
