import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import "fake-indexeddb/auto";
import { PoiAttribution } from "./PoiAttribution.tsx";
import { db } from "../../db/index.ts";

afterEach(async () => {
  cleanup();
  await db.poiSyncMeta.clear();
});

beforeEach(async () => {
  await db.poiSyncMeta.clear();
});

describe("PoiAttribution", () => {
  test("renders ODbL attribution link", () => {
    render(<PoiAttribution />);
    const link = screen.getByRole("link");
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    expect(link.textContent).toContain("OpenStreetMap");
    expect(link.textContent).toContain("ODbL");
  });

  test("shows entry count when POI data is loaded", async () => {
    await db.poiSyncMeta.put({
      cityId: "gdansk",
      activeBundleHash: "abc123",
      entryCount: 150,
      installedAt: Date.now(),
      tier: "strict",
      sourcePbfTimestamp: "2026-04-01T00:00:00Z",
      bundleGeneratedAt: "2026-04-10T12:00:00Z",
    });

    render(<PoiAttribution />);

    await waitFor(() => {
      expect(screen.getByText(/150 places indexed/)).toBeTruthy();
    });
  });

  test("shows source PBF date and generation date", async () => {
    await db.poiSyncMeta.put({
      cityId: "gdansk",
      activeBundleHash: "abc123",
      entryCount: 100,
      installedAt: Date.now(),
      tier: "strict",
      sourcePbfTimestamp: "2026-04-01T00:00:00Z",
      bundleGeneratedAt: "2026-04-10T12:00:00Z",
    });

    render(<PoiAttribution />);

    await waitFor(() => {
      expect(screen.getByText(/Source data:/)).toBeTruthy();
      expect(screen.getByText(/Generated:/)).toBeTruthy();
    });
  });

  test("aggregates entry counts across multiple cities", async () => {
    await db.poiSyncMeta.bulkPut([
      {
        cityId: "gdansk",
        activeBundleHash: "abc",
        entryCount: 100,
        installedAt: Date.now(),
        tier: "strict",
      },
      {
        cityId: "vilnius",
        activeBundleHash: "def",
        entryCount: 200,
        installedAt: Date.now(),
        tier: "strict",
      },
    ]);

    render(<PoiAttribution />);

    await waitFor(() => {
      expect(screen.getByText(/300 places indexed/)).toBeTruthy();
    });
  });

  test("excludes loose tier from entry count", async () => {
    await db.poiSyncMeta.bulkPut([
      {
        cityId: "gdansk",
        activeBundleHash: "abc",
        entryCount: 100,
        installedAt: Date.now(),
        tier: "strict",
      },
      {
        cityId: "gdansk:loose",
        activeBundleHash: "xyz",
        entryCount: 5000,
        installedAt: Date.now(),
        tier: "loose",
      },
    ]);

    render(<PoiAttribution />);

    await waitFor(() => {
      expect(screen.getByText(/100 places indexed/)).toBeTruthy();
    });
  });

  test("shows no metadata line when no POI data loaded", () => {
    render(<PoiAttribution />);
    expect(screen.queryByText(/places indexed/)).toBeNull();
  });
});
