import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "fake-indexeddb/auto";
import {
  PersonalStorageDetail,
  PersonalStorageNotice,
  SavedStorageNote,
} from "./PersonalStorageNotice.tsx";
import { db } from "../../db/index.ts";
import { usePersonalStorageStatus } from "../../services/personalStorage.ts";
import { resetPersonalStorage } from "../../test-helpers/personalStorage.ts";
import { retryPersonalStorage } from "../../services/personalStorageRecovery.ts";

vi.mock("../../services/personalStorageRecovery.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/personalStorageRecovery.ts")>();
  return { ...actual, retryPersonalStorage: vi.fn(actual.retryPersonalStorage) };
});

const FORBIDDEN = /\b(secure|safe|vault|locked)\b/i;

beforeEach(async () => {
  await resetPersonalStorage();
  usePersonalStorageStatus.setState({
    migration: "complete",
    failure: null,
    keyMode: null,
    unreadable: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("storage copy", () => {
  test("states what encryption on this device does and does not do", () => {
    render(<PersonalStorageDetail />);
    const text = screen.getByTestId("personal-storage-detail").textContent ?? "";
    expect(text).toContain("Saved places and history are encrypted on this device.");
    expect(text).toContain("Anyone who can use this browser profile can still open the app");
    expect(text).not.toMatch(FORBIDDEN);
  });

  test("the save confirmation says whether the save was kept", () => {
    const view = render(<SavedStorageNote durable />);
    expect(screen.getByTestId("saved-storage-note").textContent).toBe(
      "Saved places and history are encrypted on this device.",
    );
    view.rerender(<SavedStorageNote durable={false} />);
    expect(screen.getByTestId("saved-storage-note").textContent).toMatch(/not be kept/);
  });
});

describe("PersonalStorageNotice", () => {
  test("renders nothing when storage is working", () => {
    const { container } = render(<PersonalStorageNotice />);
    expect(container.firstChild).toBeNull();
  });

  test("says when saves are kept for this session only", () => {
    usePersonalStorageStatus.setState({ keyMode: "no-persist" });
    render(<PersonalStorageNotice />);
    const notice = screen.getByTestId("personal-storage-notice");
    expect(notice.textContent).toMatch(/will not be kept after you close the app/);
    expect(notice.textContent).not.toMatch(FORBIDDEN);
  });

  test("a failed key read offers a retry", () => {
    usePersonalStorageStatus.setState({ keyMode: "read-failed" });
    render(<PersonalStorageNotice />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  test("a failed migration offers retry and delete, and says transit still works", async () => {
    usePersonalStorageStatus.setState({ migration: "failed", failure: "storage-full" });
    await db.savedLocations.put({ id: "legacy", endpoint: { kind: "stop" }, alias: "x", savedAt: 1 } as never);
    const confirmFn = vi.fn(() => true);
    render(<PersonalStorageNotice confirmFn={confirmFn} />);
    expect(screen.getByTestId("personal-storage-notice").textContent).toMatch(
      /out of storage space.*Transit information still works/,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Delete saved places and history" }));
    expect(confirmFn).toHaveBeenCalledTimes(1);
    await waitFor(async () => {
      expect(await db.savedLocations.count()).toBe(0);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("personal-storage-notice")).toBeNull();
    });
  });

  test("delete does nothing when the rider cancels", async () => {
    await db.savedLocations.put({ id: "kept", endpoint: { kind: "stop" }, alias: "x", savedAt: 1 } as never);
    usePersonalStorageStatus.setState({ keyMode: "key-unreadable" });
    const confirmFn = vi.fn(() => false);
    render(<PersonalStorageNotice confirmFn={confirmFn} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete saved places and history" }));
    expect(confirmFn).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await db.savedLocations.count()).toBe(1);
    expect(usePersonalStorageStatus.getState().keyMode).toBe("key-unreadable");
    expect(screen.getByTestId("personal-storage-notice")).toBeDefined();
  });

  test("Try again retries the key read and the conversion", async () => {
    usePersonalStorageStatus.setState({ keyMode: "read-failed" });
    render(<PersonalStorageNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(retryPersonalStorage).toHaveBeenCalledTimes(1);
    });
    // Let the retry finish before the next test resets storage.
    await vi.mocked(retryPersonalStorage).mock.results[0].value;
  });

  test("unreadable records can be deleted on their own", () => {
    usePersonalStorageStatus.setState({ unreadable: 2 });
    render(<PersonalStorageNotice />);
    expect(screen.getByTestId("personal-storage-notice").textContent).toContain("2 saved items");
    expect(screen.getByRole("button", { name: "Delete unreadable items" })).toBeDefined();
  });

  test("progress is shown only where asked for", () => {
    usePersonalStorageStatus.setState({ migration: "running" });
    const view = render(<PersonalStorageNotice />);
    expect(screen.queryByTestId("personal-storage-notice")).toBeNull();
    view.rerender(<PersonalStorageNotice showProgress />);
    expect(screen.getByTestId("personal-storage-notice").textContent).toMatch(/Encrypting/);
  });
});
