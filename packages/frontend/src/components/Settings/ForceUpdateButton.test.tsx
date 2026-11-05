import { describe, test, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { ForceUpdateButton } from "./ForceUpdateButton.tsx";

const updateServiceWorker = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: () => ({ updateServiceWorker }),
}));

vi.mock("../../i18n/index.ts", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

afterEach(() => {
  cleanup();
  updateServiceWorker.mockClear();
});

describe("ForceUpdateButton", () => {
  test("clears caches, asks SW to update, then reloads", async () => {
    const cacheDelete = vi.fn(async () => true);
    Object.defineProperty(window, "caches", {
      configurable: true,
      value: {
        keys: vi.fn(async () => ["precache-v1", "api-stops-cache-v1"]),
        delete: cacheDelete,
      },
    });

    const swUpdate = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistrations: vi.fn(async () => [{ update: swUpdate }]),
      },
    });

    render(<ForceUpdateButton />);
    fireEvent.click(screen.getByTestId("force-update-button"));

    await waitFor(() => expect(updateServiceWorker).toHaveBeenCalledWith(true));
    expect(swUpdate).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledWith("precache-v1");
    expect(cacheDelete).toHaveBeenCalledWith("api-stops-cache-v1");
  });

  test("disables itself while running so a double-click is a no-op", async () => {
    Object.defineProperty(window, "caches", {
      configurable: true,
      value: { keys: vi.fn(async () => []), delete: vi.fn() },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistrations: vi.fn(async () => []) },
    });

    render(<ForceUpdateButton />);
    const btn = screen.getByTestId("force-update-button") as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);

    await waitFor(() => expect(updateServiceWorker).toHaveBeenCalledTimes(1));
    expect(btn.disabled).toBe(true);
  });

  test("re-enables on failure so the user can retry", async () => {
    Object.defineProperty(window, "caches", {
      configurable: true,
      value: { keys: vi.fn(async () => []), delete: vi.fn() },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistrations: vi.fn(async () => []) },
    });
    updateServiceWorker.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<ForceUpdateButton />);
    const btn = screen.getByTestId("force-update-button") as HTMLButtonElement;
    fireEvent.click(btn);

    await waitFor(() => expect(btn.disabled).toBe(false));
    warn.mockRestore();
  });
});
