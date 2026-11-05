import { describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n/I18nProvider.tsx";
import { PrivacyLevelSection } from "./PrivacyLevelSection.tsx";

// The privacy namespace is no longer merged into loadLocale, so a section that
// renders privacy copy has to ask for it. Every privacy.* call site carries an
// inline English fallback, so a section that forgets to opt in still *looks*
// fine in English — it just silently stops honouring the namespace (and, once
// M8-M11 land, stops honouring translations).
//
// `privacy.disclosure.installKey` is the discriminator: its value in
// privacy.json genuinely differs from the fallback hard-coded at the call
// site, so only a real namespace load can produce the JSON text.
const JSON_ONLY = /sealed with a per-install key/i;
const FALLBACK_ONLY = /will be generated on first use \(M8\)/i;

describe("PrivacyLevelSection opts into the lazy privacy namespace", () => {
  test("renders namespace copy, not the inline fallback", async () => {
    render(
      <I18nProvider>
        <PrivacyLevelSection />
      </I18nProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText(JSON_ONLY)).toBeTruthy(),
    );
    expect(screen.queryByText(FALLBACK_ONLY)).toBeNull();
  });

  test("never paints a raw privacy.* key", async () => {
    const { container } = render(
      <I18nProvider>
        <PrivacyLevelSection />
      </I18nProvider>,
    );
    expect(container.textContent).not.toMatch(/privacy\.[a-z]/i);
    await waitFor(() => expect(screen.getByText(JSON_ONLY)).toBeTruthy());
    expect(container.textContent).not.toMatch(/privacy\.[a-z]/i);
  });
});
