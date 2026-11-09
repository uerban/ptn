import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "fake-indexeddb/auto";
import { RecentsPurgeControl } from "./RecentsPurgeControl.tsx";
import { db } from "../../db/index.ts";
import {
  recordRecent,
  __clearRamRecentsForTests,
  __getRamRecentsForTests,
} from "../../services/recents.ts";
import { resetPersonalStorage } from "../../test-helpers/personalStorage.ts";
import { usePrivacyChoicesStore } from "../../stores/privacyChoicesStore.ts";
import {
  PRIVACY_DATA_MIGRATION_KEY,
  PRIVACY_DATA_MIGRATION_VERSION,
} from "../../services/privacyDataMigrationState.ts";

afterEach(() => {
  cleanup();
  __clearRamRecentsForTests();
  localStorage.setItem(
    PRIVACY_DATA_MIGRATION_KEY,
    PRIVACY_DATA_MIGRATION_VERSION,
  );
  usePrivacyChoicesStore.getState().setChoice("recents", "enabled");
});

beforeEach(async () => {
  await resetPersonalStorage();
  usePrivacyChoicesStore.getState().setChoice("recents", "enabled");
});

describe("RecentsPurgeControl", () => {
  test("renders a Purge button", () => {
    render(<RecentsPurgeControl confirmFn={() => false} />);
    expect(screen.getByRole("button", { name: /purge/i })).toBeDefined();
  });

  test("does nothing when the user cancels the confirm dialog", async () => {
    const onPurge = vi.fn(async () => {});
    const confirmFn = vi.fn(() => false);
    render(<RecentsPurgeControl confirmFn={confirmFn} onPurge={onPurge} />);
    fireEvent.click(screen.getByRole("button", { name: /purge/i }));
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(onPurge).not.toHaveBeenCalled();
  });

  test("invokes the purge handler when the user confirms", async () => {
    const onPurge = vi.fn(async () => {});
    render(
      <RecentsPurgeControl confirmFn={() => true} onPurge={onPurge} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /purge/i }));
    await waitFor(() => expect(onPurge).toHaveBeenCalledTimes(1));
  });

  test("end-to-end: confirmed click clears persisted + RAM recents", async () => {
    await recordRecent(
      { kind: "stop", stopId: "S1", name: "C", lat: 0, lon: 0 },
      { usedAsOrigin: true, now: () => 1, tier: "encrypted" },
    );
    await recordRecent(
      { kind: "stop", stopId: "S2", name: "D", lat: 0, lon: 0 },
      { usedAsOrigin: false, now: () => 2, tier: "ram-only" },
    );
    expect(await db.recentLocations.count()).toBe(1);
    expect((await __getRamRecentsForTests()).size).toBe(1);

    render(<RecentsPurgeControl confirmFn={() => true} />);
    fireEvent.click(screen.getByRole("button", { name: /purge/i }));

    await waitFor(async () => {
      expect(await db.recentLocations.count()).toBe(0);
    });
    expect((await __getRamRecentsForTests()).size).toBe(0);
  });

  test("shows a confirmation message after a successful purge", async () => {
    render(<RecentsPurgeControl confirmFn={() => true} onPurge={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /purge/i }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeDefined();
    });
  });
});
