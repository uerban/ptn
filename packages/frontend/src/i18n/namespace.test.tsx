import { describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "./I18nProvider.tsx";
import { useTranslation, usePrivacyNamespace } from "./index.ts";

// A privacy key reached only by template interpolation — it carries no inline
// English fallback at its call site, so it renders as the raw key until the
// namespace is resident. This is the case the lazy boundary must protect.
const TEMPLATED_KEY = "privacy.level.paranoid.name";

function WithoutNamespace() {
  const { t } = useTranslation();
  return <span data-testid="out">{t(TEMPLATED_KEY)}</span>;
}

function WithNamespace() {
  const ready = usePrivacyNamespace();
  const { t } = useTranslation();
  return <span data-testid="out">{ready ? t(TEMPLATED_KEY) : "loading"}</span>;
}

describe("privacy namespace is loaded on demand", () => {
  test("a consumer that does not opt in never pays for the namespace", async () => {
    render(
      <I18nProvider>
        <WithoutNamespace />
      </I18nProvider>,
    );
    // Base locale settles first; the privacy key stays unresolved.
    await waitFor(() => expect(screen.getByTestId("out")).toBeTruthy());
    expect(screen.getByTestId("out").textContent).toBe(TEMPLATED_KEY);
  });

  test("usePrivacyNamespace resolves the templated key once loaded", async () => {
    render(
      <I18nProvider>
        <WithNamespace />
      </I18nProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("out").textContent).toBe("Paranoid"),
    );
  });
});
