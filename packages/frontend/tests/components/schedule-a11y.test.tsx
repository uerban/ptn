import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { axe } from "jest-axe";
import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n/index.ts";
import { NearbyStopsList } from "../../src/components/Schedule/NearbyStopsList.tsx";
import { StopCard } from "../../src/components/Schedule/StopCard.tsx";
import { ExpandableStopGroup } from "../../src/components/Schedule/ExpandableStopGroup.tsx";
import type { StopGroupRecord } from "../../src/db/index.ts";
import type { DirectionLabel } from "../../src/services/directionResolver.ts";

// Mock stores to avoid IndexedDB/Dexie issues
vi.mock("../../src/stores/gtfsDataStore.ts", () => ({
  useGtfsDataStore: (selector: (s: { raptorIndex: null; stopNames: null }) => unknown) =>
    selector({ raptorIndex: null, stopNames: null }),
}));

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

const baseGroup: StopGroupRecord = {
  groupId: "g1",
  name: "Central Station",
  stopIds: ["s1", "s2"],
  type: "parent_station",
  lat: 54.68,
  lon: 25.28,
};

const directions: DirectionLabel[] = [
  { label: "Oliwa", routeLabels: ["1"], routeColors: ["e53935"] },
];

describe("Schedule mode screen reader support (US-035)", () => {
  describe("NearbyStopsList", () => {
    it("renders a semantic <ul> list", () => {
      const { container } = render(
        <NearbyStopsList
          groups={[baseGroup]}
          userLocation={{ lat: 54.68, lon: 25.28 }}
          onStopSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      const list = container.querySelector("ul[role='list']");
      expect(list).not.toBeNull();
    });

    it("includes stop count in aria-label", () => {
      render(
        <NearbyStopsList
          groups={[baseGroup]}
          userLocation={{ lat: 54.68, lon: 25.28 }}
          onStopSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      const list = screen.getByTestId("nearby-stops-list");
      const label = list.getAttribute("aria-label") ?? "";
      expect(label).toContain("1");
      // "schedule.stop_list" key formats as "{count} nearby stops"
      expect(label.toLowerCase()).toContain("nearby stops");
    });

    it("uses <li> elements for list items", () => {
      const { container } = render(
        <NearbyStopsList
          groups={[baseGroup]}
          userLocation={{ lat: 54.68, lon: 25.28 }}
          onStopSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      const items = container.querySelectorAll("ul > li");
      expect(items.length).toBeGreaterThanOrEqual(1);
    });

    it("getByRole('listitem') returns the expected count and order", () => {
      const groups: StopGroupRecord[] = [
        { ...baseGroup, groupId: "first", name: "First Stop", stopIds: ["a1"] },
        { ...baseGroup, groupId: "second", name: "Second Stop", stopIds: ["b1"] },
        { ...baseGroup, groupId: "third", name: "Third Stop", stopIds: ["c1"] },
      ];
      const { getAllByRole } = render(
        <NearbyStopsList
          groups={groups}
          userLocation={{ lat: 54.68, lon: 25.28 }}
          onStopSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      // Each group renders one <li> at the top level of the <ul role="list">.
      // All groups share coordinates, so insertion order is preserved.
      const items = getAllByRole("listitem");
      expect(items).toHaveLength(3);
      expect(items[0].textContent).toContain("First Stop");
      expect(items[1].textContent).toContain("Second Stop");
      expect(items[2].textContent).toContain("Third Stop");
    });

    it("has no a11y violations", async () => {
      const { container } = render(
        <NearbyStopsList
          groups={[
            baseGroup,
            { ...baseGroup, groupId: "g-other", name: "Town Hall", stopIds: ["t1"] },
          ]}
          userLocation={{ lat: 54.68, lon: 25.28 }}
          onStopSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe("StopCard", () => {
    it("has aria-describedby linking to a visually hidden summary", () => {
      render(
        <StopCard
          group={baseGroup}
          distanceMeters={200}
          lineLabels={["1", "3"]}
          lineColors={new Map()}
          directionLabels={directions}
          onSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      const card = screen.getByTestId("stop-card");
      const describedBy = card.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();

      // The referenced element should exist and contain the stop name
      const summary = document.getElementById(describedBy!);
      expect(summary).not.toBeNull();
      expect(summary!.textContent).toContain("Central Station");
      expect(summary!.textContent).toContain("2");
      expect(summary!.textContent).toContain("lines");
    });

    it("includes comprehensive aria-label with name, distance, and lines", () => {
      render(
        <StopCard
          group={baseGroup}
          distanceMeters={200}
          lineLabels={["1", "3"]}
          lineColors={new Map()}
          directionLabels={directions}
          onSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      const card = screen.getByTestId("stop-card");
      const label = card.getAttribute("aria-label")!;
      expect(label).toContain("Central Station");
      expect(label).toContain("200 m");
      expect(label).toContain("1, 3");
    });

    it("has no a11y violations", async () => {
      const { container } = render(
        <StopCard
          group={baseGroup}
          distanceMeters={200}
          lineLabels={["1", "3"]}
          lineColors={new Map([["1", "#e53935"]])}
          directionLabels={directions}
          onSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe("ExpandableStopGroup", () => {
    it("has aria-expanded toggle button with name and platform count", () => {
      render(
        <ExpandableStopGroup
          group={{ ...baseGroup, type: "name_numbered" }}
          distanceMeters={100}
          lineLabels={["1"]}
          lineColors={new Map()}
          directionLabels={[]}
          platformCodes={new Map()}
          stopNames={new Map([["s1", "Stop A"], ["s2", "Stop B"]])}
          onStopSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      const toggle = screen.getByTestId("group-expand-toggle");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      const label = toggle.getAttribute("aria-label")!;
      expect(label).toContain("Central Station");
      expect(label).toContain("2");
      expect(label).toContain("platforms");
    });

    it("substops list has aria-controls link and label", () => {
      render(
        <ExpandableStopGroup
          group={{ ...baseGroup, type: "name_numbered" }}
          distanceMeters={100}
          lineLabels={["1"]}
          lineColors={new Map()}
          directionLabels={[]}
          platformCodes={new Map()}
          stopNames={new Map([["s1", "Stop A"], ["s2", "Stop B"]])}
          onStopSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );

      const toggle = screen.getByTestId("group-expand-toggle");
      const controlsId = toggle.getAttribute("aria-controls");
      expect(controlsId).toBeTruthy();

      // Expand to see substops
      fireEvent.click(toggle);

      const substops = document.getElementById(controlsId!);
      expect(substops).not.toBeNull();
      expect(substops!.getAttribute("aria-label")).toContain("Platforms");
    });

    it("has no a11y violations (collapsed)", async () => {
      const { container } = render(
        <ExpandableStopGroup
          group={{ ...baseGroup, type: "name_numbered" }}
          distanceMeters={100}
          lineLabels={["1"]}
          lineColors={new Map()}
          directionLabels={[]}
          platformCodes={new Map([["s1", "A"], ["s2", "B"]])}
          stopNames={new Map([["s1", "Stop A"], ["s2", "Stop B"]])}
          onStopSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it("has no a11y violations (expanded)", async () => {
      const { container } = render(
        <ExpandableStopGroup
          group={{ ...baseGroup, type: "name_numbered" }}
          distanceMeters={100}
          lineLabels={["1"]}
          lineColors={new Map()}
          directionLabels={[]}
          platformCodes={new Map([["s1", "A"], ["s2", "B"]])}
          stopNames={new Map([["s1", "Stop A"], ["s2", "Stop B"]])}
          onStopSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      // Expand via the toggle to verify expanded-state markup is also clean
      fireEvent.click(screen.getByTestId("group-expand-toggle"));
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });
});
