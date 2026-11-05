import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { PolicyAxisControl } from "./PolicyAxisControl.tsx";
import { I18nProvider } from "../../i18n/I18nProvider.tsx";
import { usePrivacyNamespace } from "../../i18n/index.ts";
import { usePrivacyStore } from "../../stores/privacyStore.ts";

afterEach(cleanup);
beforeEach(() => {
  usePrivacyStore.getState().reset();
});

// privacy.json stores lockedCopy as a template:
//   "Locked to {value} by the {level} preset. Lower your privacy level to
//    {minLevel} to enable it."
// The call site must substitute those placeholders. It previously only
// interpolated its inline JS fallback, so whenever the privacy namespace
// resolved — i.e. always, before the namespace was made lazy — the user saw
// the raw {value}/{level}/{minLevel} braces.
// The real screen (PrivacyLevelSection) opts into the privacy namespace, so
// the JSON template — not the inline JS fallback — is what the user sees.
function WithNamespace({ children }: { children: React.ReactNode }) {
  usePrivacyNamespace();
  return <>{children}</>;
}

describe("PolicyAxisControl locked copy", () => {
  test("substitutes the placeholders in the namespace template", async () => {
    render(
      <I18nProvider>
        <WithNamespace>
          <PolicyAxisControl
            axis="mapTapPersistedPrecision"
            i18nKeyPrefix="privacy.axis.mapTapPersistedPrecision"
          />
        </WithNamespace>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Locked to/i)).toBeTruthy();
    });

    const locked = screen.getByText(/Locked to/i);
    expect(locked.textContent).not.toMatch(/\{value\}/);
    expect(locked.textContent).not.toMatch(/\{level\}/);
    expect(locked.textContent).not.toMatch(/\{minLevel\}/);
    // The substituted values must actually appear.
    expect(locked.textContent).toMatch(/standard/i);
  });

  test("no rendered text anywhere retains an unsubstituted placeholder", async () => {
    const { container } = render(
      <I18nProvider>
        <WithNamespace>
          <PolicyAxisControl
            axis="mapTapPersistedPrecision"
            i18nKeyPrefix="privacy.axis.mapTapPersistedPrecision"
          />
        </WithNamespace>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Locked to/i)).toBeTruthy());
    expect(container.textContent).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});
