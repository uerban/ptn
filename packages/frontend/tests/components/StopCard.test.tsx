import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n/index.ts";
import { StopCard } from "../../src/components/Schedule/StopCard.tsx";
import type { StopGroupRecord } from "../../src/db/index.ts";
import type { DirectionLabel } from "../../src/services/directionResolver.ts";

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
  stopIds: ["s1", "s2", "s3"],
  type: "parent_station",
  lat: 54.68,
  lon: 25.28,
};

const baseDirections: DirectionLabel[] = [
  { label: "Oliwa", routeLabels: ["1", "3"], routeColors: ["e53935", "1e88e5"] },
  { label: "Wrzeszcz", routeLabels: ["5"], routeColors: ["43a047"] },
];

describe("StopCard", () => {
  it("renders group name and distance in meters", () => {
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={baseDirections}
        onSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByTestId("stop-name").textContent).toBe("Central Station");
    expect(screen.getByTestId("stop-distance").textContent).toBe("50 m");
  });

  it("renders distance in km when >= 1000 m", () => {
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={1500}
        lineLabels={["1"]}
        lineColors={new Map()}
        directionLabels={[]}
        onSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByTestId("stop-distance").textContent).toBe("1.5 km");
  });

  it("shows up to 3 line badges and +N overflow for extras", () => {
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={100}
        lineLabels={["1", "3", "5", "7", "9"]}
        lineColors={new Map()}
        directionLabels={[]}
        onSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    const badges = screen.getAllByTestId("line-badge");
    expect(badges).toHaveLength(3);
    expect(badges[0].textContent).toBe("1");
    expect(badges[1].textContent).toBe("3");
    expect(badges[2].textContent).toBe("5");
    expect(screen.getByTestId("line-overflow").textContent).toBe("+2");
  });

  it("shows exactly 3 badges with no overflow when lineLabels.length === 3", () => {
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={100}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={[]}
        onSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getAllByTestId("line-badge")).toHaveLength(3);
    expect(screen.queryByTestId("line-overflow")).toBeNull();
  });

  it("shows direction labels for bidirectional stops", () => {
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={baseDirections}
        onSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    const labels = screen.getAllByTestId("direction-label");
    expect(labels).toHaveLength(2);
    expect(labels[0].textContent).toContain("Oliwa");
    expect(labels[1].textContent).toContain("Wrzeszcz");
  });

  it("shows platform codes when provided", () => {
    const platformCodes = new Map([
      ["s1", "Bay 01"],
      ["s2", "Bay 02"],
    ]);
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1"]}
        lineColors={new Map()}
        directionLabels={[]}
        platformCodes={platformCodes}
        onSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    const platformBadges = screen.getAllByTestId("platform-badge");
    expect(platformBadges).toHaveLength(2);
    const texts = platformBadges.map((b) => b.textContent);
    expect(texts).toContain("Bay 01");
    expect(texts).toContain("Bay 02");
  });

  it("does not render platform section when platformCodes is empty", () => {
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1"]}
        lineColors={new Map()}
        directionLabels={[]}
        platformCodes={new Map()}
        onSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByTestId("platform-codes")).toBeNull();
  });

  it("shows Transfer badge for >= 3 routes", () => {
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={baseDirections}
        onSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByTestId("transfer-badge")).toBeDefined();
  });

  it("does not show Transfer badge for < 3 routes", () => {
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1", "3"]}
        lineColors={new Map()}
        directionLabels={[]}
        onSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByTestId("transfer-badge")).toBeNull();
  });

  it("aria-label includes name, transfer, distance, lines, and directions", () => {
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={baseDirections}
        onSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    const card = screen.getByTestId("stop-card");
    const label = card.getAttribute("aria-label") ?? "";
    expect(label).toContain("Central Station");
    expect(label).toContain("transfer point");
    expect(label).toContain("50 m away");
    expect(label).toContain("lines 1, 3, 5");
    expect(label).toContain("toward Oliwa");
    expect(label).toContain("toward Wrzeszcz");
  });

  it("calls onSelect when clicked", () => {
    const onSelect = vi.fn();
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1"]}
        lineColors={new Map()}
        directionLabels={[]}
        onSelect={onSelect}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId("stop-card"));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("calls onSelect on Enter key", () => {
    const onSelect = vi.fn();
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1"]}
        lineColors={new Map()}
        directionLabels={[]}
        onSelect={onSelect}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.keyDown(screen.getByTestId("stop-card"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("shows chevron expand button when expandable is true", () => {
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1"]}
        lineColors={new Map()}
        directionLabels={[]}
        onSelect={vi.fn()}
        expandable={true}
        onExpand={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByTestId("expand-btn")).toBeDefined();
  });

  it("does not show chevron when expandable is false", () => {
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1"]}
        lineColors={new Map()}
        directionLabels={[]}
        onSelect={vi.fn()}
        expandable={false}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByTestId("expand-btn")).toBeNull();
  });

  it("calls onExpand and not onSelect when expand button is clicked", () => {
    const onSelect = vi.fn();
    const onExpand = vi.fn();
    render(
      <StopCard
        group={baseGroup}
        distanceMeters={50}
        lineLabels={["1"]}
        lineColors={new Map()}
        directionLabels={[]}
        onSelect={onSelect}
        expandable={true}
        onExpand={onExpand}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId("expand-btn"));
    expect(onExpand).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
