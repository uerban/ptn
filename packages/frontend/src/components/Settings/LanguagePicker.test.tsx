import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LanguagePicker } from "./LanguagePicker.tsx";
import { SUPPORTED_LOCALES } from "../../i18n/index.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  useSettingsStore.getState().setLanguage("auto");
});

function stubNavigatorLanguage(tag: string) {
  vi.stubGlobal("navigator", { ...window.navigator, language: tag });
}

const radios = () => screen.getAllByRole("radio") as HTMLInputElement[];
const values = () => radios().map((r) => r.value);

describe("LanguagePicker", () => {
  test("collapsed by default — does not list every locale", () => {
    stubNavigatorLanguage("lt-LT");
    render(<LanguagePicker />);
    // auto + detected (lt) + English. Never the full 7-row wall.
    expect(values()).toEqual(["auto", "lt", "en"]);
  });

  test("expanding reveals the remaining locales", () => {
    stubNavigatorLanguage("lt-LT");
    render(<LanguagePicker />);
    fireEvent.click(screen.getByRole("button", { name: /more languages/i }));
    expect(values()).toEqual(
      expect.arrayContaining(["auto", "en", "lt", "pl", "be", "ru", "uk"]),
    );
  });

  test("the active language stays visible while collapsed", () => {
    stubNavigatorLanguage("en-GB");
    useSettingsStore.getState().setLanguage("uk");
    render(<LanguagePicker />);
    // uk is neither detected nor English, but it is the current choice.
    expect(values()).toContain("uk");
    expect(radios().find((r) => r.value === "uk")?.checked).toBe(true);
  });

  test("shows each language under its own endonym", () => {
    stubNavigatorLanguage("en-GB");
    render(<LanguagePicker />);
    fireEvent.click(screen.getByRole("button", { name: /more languages/i }));
    for (const endonym of [
      "English",
      "Lietuvių",
      "Polski",
      "Беларуская",
      "Русский",
      "Українська",
    ]) {
      expect(screen.getByText(endonym)).toBeTruthy();
    }
  });

  test("the radio group carries an accessible name", () => {
    stubNavigatorLanguage("en-GB");
    render(<LanguagePicker />);
    // This section was the only radio group in Settings missing these.
    expect(screen.getByRole("radiogroup", { name: /language/i })).toBeTruthy();
  });

  test("the expander toggles and reports its state", () => {
    stubNavigatorLanguage("lt-LT");
    render(<LanguagePicker />);
    const btn = () => screen.getByRole("button", { name: /languages/i });
    expect(btn().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn());
    expect(btn().getAttribute("aria-expanded")).toBe("true");
    // Still present after expanding — the control must not vanish, or the
    // keyboard user who opened it loses focus to the document body.
    fireEvent.click(btn());
    expect(btn().getAttribute("aria-expanded")).toBe("false");
    expect(values()).toEqual(["auto", "lt", "en"]);
  });

  test("the expander names how many locales are hidden", () => {
    stubNavigatorLanguage("lt-LT");
    render(<LanguagePicker />);
    // 11 locales, 2 of them shown (lt, en) -> 9 behind the expander. The
    // count is derived, so this stays honest as languages are added.
    const hidden = SUPPORTED_LOCALES.length - 2;
    expect(
      screen.getByRole("button", { name: new RegExp(String(hidden)) }),
    ).toBeTruthy();
  });

  test("selecting a language writes it to the store", () => {
    stubNavigatorLanguage("lt-LT");
    render(<LanguagePicker />);
    fireEvent.click(radios().find((r) => r.value === "lt")!);
    expect(useSettingsStore.getState().language).toBe("lt");
  });
});
