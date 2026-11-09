import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SaveEntryActions } from "./SaveEntryActions.tsx";
import { usePrivacyStore } from "../../stores/privacyStore.ts";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  usePrivacyStore.getState().reset();
});

describe("SaveEntryActions visibility by policy axis", () => {
  test("shows both export and share when saves are always encrypted", () => {
    render(<SaveEntryActions saveId="s1" axisOverride="always" />);
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  test("shows both at Standard", () => {
    usePrivacyStore.getState().reset();
    render(<SaveEntryActions saveId="s1" />);
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  test("shows both at Hardened (always)", () => {
    render(<SaveEntryActions saveId="s1" axisOverride="always" />);
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  test("hides export but keeps share at Strict (always-no-export)", () => {
    render(<SaveEntryActions saveId="s1" axisOverride="always-no-export" />);
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  test("hides both export and share at Paranoid (always-no-share)", () => {
    const { container } = render(
      <SaveEntryActions saveId="s1" axisOverride="always-no-share" />,
    );
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(container.querySelector("[role=group]")).toBeNull();
  });

  test("reads axis from privacy store when no override provided", async () => {
    await usePrivacyStore.getState().setLevel("strict");
    render(<SaveEntryActions saveId="s1" />);
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  test("invokes onExport and onShare callbacks with saveId", () => {
    const onExport = vi.fn();
    const onShare = vi.fn();
    render(
      <SaveEntryActions
        saveId="s1"
        axisOverride="always"
        onExport={onExport}
        onShare={onShare}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(onExport).toHaveBeenCalledWith("s1");
    expect(onShare).toHaveBeenCalledWith("s1");
  });
});
