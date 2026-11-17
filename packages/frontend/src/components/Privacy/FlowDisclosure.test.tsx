import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nContext } from "../../i18n/index.ts";
import { canUse } from "../../privacy/canUse.ts";
import { __resetContextualPromptsForTests } from "../../privacy/contextualPrompts.ts";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";
import { FlowDisclosure, type FlowDisclosureProps } from "./FlowDisclosure.tsx";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider
      value={{
        locale: "en",
        formattingLocale: "en",
        t: (key, fallback) => fallback ?? key,
        privacyReady: true,
        ensurePrivacyNamespace: () => {},
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

function renderDisclosure(props: Partial<FlowDisclosureProps> = {}) {
  const onClose = vi.fn();
  render(
    <FlowDisclosure
      flowId="external.detailed-basemap"
      providerId="carto"
      recipientName="CARTO"
      surface="test"
      heading="More map detail"
      allowLabel="Show detailed map"
      onClose={onClose}
      {...props}
    />,
    { wrapper: Wrapper },
  );
  return onClose;
}

beforeEach(() => {
  localStorage.clear();
  useNetworkDecisionsStore.getState().reset();
  __resetContextualPromptsForTests();
});
afterEach(cleanup);

describe("FlowDisclosure dialog", () => {
  it("takes focus on itself, never on Allow", () => {
    renderDisclosure();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(canUse("external.detailed-basemap", "carto")).toBe(false);
  });

  it("keeps Tab inside the dialog", () => {
    renderDisclosure();
    // The scrollable text is the first stop, so the keyboard can scroll it.
    const first = screen.getByTestId("flow-disclosure-body");
    const buttons = screen.getAllByRole("button");
    const last = buttons[buttons.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("puts the main action first and keeps the actions outside the scrolling text", () => {
    renderDisclosure();
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Show detailed map", "Not now", "Don't ask again"]);
    const body = screen.getByTestId("flow-disclosure-body");
    expect(body.getAttribute("role")).toBeNull();
    // Described by the purpose line only, not by the whole text.
    const describedBy = screen.getByRole("dialog").getAttribute("aria-describedby")!;
    expect(body.contains(document.getElementById(describedBy))).toBe(true);
    expect(document.getElementById(describedBy)!.tagName).toBe("P");
    expect(body.contains(screen.getByRole("button", { name: "Not now" }))).toBe(false);
  });

  it("Escape answers Not now and records nothing", () => {
    const onClose = renderDisclosure();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("not-now");
    expect(useNetworkDecisionsStore.getState().decisions).toEqual({});
  });

  it("Allow grants only the named provider, and revoking it closes it again", () => {
    const onClose = renderDisclosure();
    fireEvent.click(screen.getByRole("button", { name: "Show detailed map" }));
    expect(onClose).toHaveBeenCalledWith("allowed");
    expect(Object.keys(useNetworkDecisionsStore.getState().decisions)).toEqual([
      "external.detailed-basemap@carto",
    ]);
    useNetworkDecisionsStore
      .getState()
      .setDecision("external.detailed-basemap", "denied", "settings", "carto");
    expect(canUse("external.detailed-basemap", "carto")).toBe(false);
  });
});

describe("FlowDisclosure inline", () => {
  it("answers Escape only from within itself", () => {
    const onClose = renderDisclosure({ variant: "inline" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("flow-disclosure"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("not-now");
  });
});
