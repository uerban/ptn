import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ServiceNotice } from "@pt/shared";
import { I18nContext } from "../../i18n/index.ts";
import { NoticeBadge } from "./NoticeBadge.tsx";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: (k, f) => f ?? k, privacyReady: true, ensurePrivacyNamespace: () => {} }}>
      {children}
    </I18nContext.Provider>
  );
}

const xmas: ServiceNotice = {
  id: "xmas", routeIds: ["201"], kind: "seasonal", free: true,
  windows: [{ start: "2026-11-27T22:00:00Z", end: "2026-12-31T22:00:00Z" }],
  displayUntil: "2026-12-31", source: "https://example.org",
};
const choir: ServiceNotice = { ...xmas, id: "choir", kind: "event", free: false, displayUntil: "2026-12-03", text: { en: "Choir on board" } };

afterEach(cleanup);

describe("NoticeBadge", () => {
  it("renders nothing without notices", () => {
    const { container } = render(<NoticeBadge notices={[]} />, { wrapper: Wrapper });
    expect(container.textContent).toBe("");
  });

  it("shows the kind icon and says free ride in words", () => {
    render(<NoticeBadge notices={[xmas]} />, { wrapper: Wrapper });
    const badge = screen.getByTestId("service-notice-badge");
    expect(badge.textContent).toContain("🎄");
    expect(badge.textContent).toContain("Free ride");
  });

  it("an event uses 🔔 and the editor's text, kept for screen readers when compact", () => {
    render(<NoticeBadge notices={[choir]} compact />, { wrapper: Wrapper });
    const badge = screen.getByTestId("service-notice-badge");
    expect(badge.textContent).toContain("🔔");
    expect(badge.querySelector(".sr-only")?.textContent).toBe("Choir on board");
  });

  it("a seasonal notice without text falls back to its end date", () => {
    render(<NoticeBadge notices={[{ ...xmas, free: false }]} />, { wrapper: Wrapper });
    expect(screen.getByTestId("service-notice-badge").textContent).toMatch(/until 31 December|until December 31/);
  });
});
