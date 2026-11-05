import { describe, test, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { VersionBlock } from "./VersionBlock.tsx";

vi.mock("../../buildInfo.ts", () => ({
  buildInfo: { version: "0.1.247", commit: "abcd123", builtAt: "2026-05-04T18:23:11Z" },
}));

vi.mock("../../i18n/index.ts", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

const mockBackendState = vi.hoisted(() => ({
  current: {
    status: "ok" as "ok" | "loading" | "error",
    data: { version: "0.1.246", commit: "cafef00d", builtAt: "2026-05-04T18:18:02Z" } as { version: string; commit: string; builtAt: string } | null,
  },
}));

vi.mock("../../hooks/useBackendBuildInfo.ts", () => ({
  useBackendBuildInfo: () => mockBackendState.current,
}));

const ORIGINAL_CLIPBOARD = navigator.clipboard;

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: ORIGINAL_CLIPBOARD });
  mockBackendState.current = {
    status: "ok",
    data: { version: "0.1.246", commit: "cafef00d", builtAt: "2026-05-04T18:18:02Z" },
  };
});

describe("VersionBlock", () => {
  test("renders the frontend and backend versions", () => {
    render(<VersionBlock />);
    expect(screen.getByText(/v0\.1\.247/).textContent).toContain("abcd123");
    expect(screen.getByText(/v0\.1\.246/).textContent).toContain("cafef00d");
  });

  test("renders builtAt timestamps so freshness is visible even when commit is 'unknown'", () => {
    render(<VersionBlock />);
    expect(screen.getByText("2026-05-04 18:23 UTC")).toBeTruthy();
    expect(screen.getByText("2026-05-04 18:18 UTC")).toBeTruthy();
  });

  test("renders em-dash for backend when status=error", () => {
    mockBackendState.current = { status: "error", data: null };
    render(<VersionBlock />);
    const backendLine = screen.getByTestId("version-backend");
    expect(backendLine.textContent).toContain("—");
  });

  test("clicking copies a feedback block to clipboard via navigator.clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<VersionBlock />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const written = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(written).toContain("Frontend: v0.1.247 (abcd123)");
    expect(written).toContain("Backend:  v0.1.246 (cafef00d)");
    expect(written).toContain("UA:");
  });

  test("falls back to execCommand when navigator.clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const execSpy = vi.spyOn(document, "execCommand").mockReturnValue(true);

    render(<VersionBlock />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(execSpy).toHaveBeenCalledWith("copy"));
  });

  test("shows 'Copy failed' when both clipboard API and execCommand fail", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    vi.spyOn(document, "execCommand").mockReturnValue(false);

    render(<VersionBlock />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(screen.getByText("Copy failed")).toBeTruthy(),
    );
  });

  test("fires onClick on every click, alongside the copy", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const onClick = vi.fn();

    render(<VersionBlock onClick={onClick} />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(3));
  });

  test("when backend is unavailable, copy block writes 'Backend: unavailable'", async () => {
    mockBackendState.current = { status: "error", data: null };
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<VersionBlock />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect((writeText.mock.calls[0] as unknown as [string])[0]).toContain("Backend: unavailable");
  });
});
