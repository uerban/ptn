import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n/index.ts";
import { ExpandableStopGroup } from "../../src/components/Schedule/ExpandableStopGroup.tsx";
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
  name: "Main Square",
  stopIds: ["s1", "s2", "s3"],
  type: "name_cluster",
  lat: 54.68,
  lon: 25.28,
};

const directionLabels: DirectionLabel[] = [
  { label: "North", routeLabels: ["1"], routeColors: ["e53935"] },
];

const platformCodes = new Map([
  ["s1", "Bay 01"],
  ["s2", "Bay 02"],
  ["s3", "Bay 03"],
]);

describe("ExpandableStopGroup", () => {
  it("starts collapsed — sub-stops are hidden", () => {
    render(
      <ExpandableStopGroup
        group={baseGroup}
        distanceMeters={100}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={directionLabels}
        platformCodes={platformCodes}
        stopNames={new Map()}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByTestId("substops-list")).toBeNull();
  });

  it("renders the header StopCard", () => {
    render(
      <ExpandableStopGroup
        group={baseGroup}
        distanceMeters={100}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={directionLabels}
        platformCodes={platformCodes}
        stopNames={new Map()}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByTestId("stop-card")).toBeDefined();
    expect(screen.getByTestId("stop-name").textContent).toBe("Main Square");
  });

  it("click on expand button reveals sub-stops", () => {
    render(
      <ExpandableStopGroup
        group={baseGroup}
        distanceMeters={100}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={directionLabels}
        platformCodes={platformCodes}
        stopNames={new Map()}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId("group-expand-toggle"));
    expect(screen.getByTestId("substops-list")).toBeDefined();
    const substops = screen.getAllByTestId("substop-item");
    expect(substops).toHaveLength(3);
  });

  it("each sub-stop shows its platform code badge", () => {
    render(
      <ExpandableStopGroup
        group={baseGroup}
        distanceMeters={100}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={directionLabels}
        platformCodes={platformCodes}
        stopNames={new Map()}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId("group-expand-toggle"));
    const platformBadges = screen.getAllByTestId("substop-platform-badge");
    const badgeTexts = platformBadges.map((b) => b.textContent);
    expect(badgeTexts).toContain("Bay 01");
    expect(badgeTexts).toContain("Bay 02");
    expect(badgeTexts).toContain("Bay 03");
  });

  it("aria-expanded toggles correctly when expand button is clicked", () => {
    render(
      <ExpandableStopGroup
        group={baseGroup}
        distanceMeters={100}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={directionLabels}
        platformCodes={platformCodes}
        stopNames={new Map()}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    const toggle = screen.getByTestId("group-expand-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByTestId("group-expand-toggle"));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByTestId("group-expand-toggle"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("calls onStopSelect with correct stopId when sub-stop is tapped", () => {
    const onStopSelect = vi.fn();
    render(
      <ExpandableStopGroup
        group={baseGroup}
        distanceMeters={100}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={directionLabels}
        platformCodes={platformCodes}
        stopNames={new Map()}
        onStopSelect={onStopSelect}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId("group-expand-toggle"));
    fireEvent.click(screen.getByTestId("substop-btn-s2"));
    expect(onStopSelect).toHaveBeenCalledWith("s2");
  });

  it("sub-stop is keyboard accessible via Enter key", () => {
    const onStopSelect = vi.fn();
    render(
      <ExpandableStopGroup
        group={baseGroup}
        distanceMeters={100}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={directionLabels}
        platformCodes={platformCodes}
        stopNames={new Map()}
        onStopSelect={onStopSelect}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId("group-expand-toggle"));
    fireEvent.keyDown(screen.getByTestId("substop-btn-s1"), { key: "Enter" });
    expect(onStopSelect).toHaveBeenCalledWith("s1");
  });

  it("keyboard Space on group-expand-toggle also toggles expansion", () => {
    render(
      <ExpandableStopGroup
        group={baseGroup}
        distanceMeters={100}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={directionLabels}
        platformCodes={platformCodes}
        stopNames={new Map()}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    const toggle = screen.getByTestId("group-expand-toggle");
    fireEvent.keyDown(toggle, { key: " " });
    expect(screen.getByTestId("substops-list")).toBeDefined();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("second expand-button click collapses sub-stops again", () => {
    render(
      <ExpandableStopGroup
        group={baseGroup}
        distanceMeters={100}
        lineLabels={["1", "3", "5"]}
        lineColors={new Map()}
        directionLabels={directionLabels}
        platformCodes={platformCodes}
        stopNames={new Map()}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId("group-expand-toggle"));
    expect(screen.getByTestId("substops-list")).toBeDefined();
    fireEvent.click(screen.getByTestId("group-expand-toggle"));
    expect(screen.queryByTestId("substops-list")).toBeNull();
  });
});
