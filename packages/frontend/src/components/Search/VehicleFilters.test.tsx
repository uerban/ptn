import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VehicleFilters, type VehicleFilter } from "./VehicleFilters.tsx";

vi.mock("../TransportModeIcon.tsx", () => ({
  TransportModeIcon: () => <span aria-hidden="true">●</span>,
}));

afterEach(() => vi.restoreAllMocks());

it("fits enabled vehicle names first while keeping compact buttons named", () => {
  const items: VehicleFilter[] = [
    { id: "metro", mode: "METRO", label: "Metro", excluded: true, onClick: vi.fn() },
    { id: "bus", mode: "BUS", label: "Bus", excluded: false, onClick: vi.fn() },
  ];
  let width = 135;
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return new DOMRect(0, 0, this.childElementCount === 2 ? 85 : 40, 40);
  });

  const { rerender } = render(<VehicleFilters items={items} label="Vehicles" />);
  const metro = screen.getByRole("button", { name: "Metro" });
  const bus = screen.getByRole("button", { name: "Bus" });
  expect(bus.textContent).toContain("Bus");
  expect(metro.textContent).not.toContain("Metro");
  expect(metro.getAttribute("aria-pressed")).toBe("false");

  width = 200;
  rerender(<VehicleFilters items={[...items]} label="Vehicles" />);
  expect(bus.textContent).toContain("Bus");
  expect(metro.textContent).toContain("Metro");
});
