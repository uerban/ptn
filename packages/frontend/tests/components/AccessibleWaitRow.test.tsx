import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AccessibleWaitRow } from "../../src/components/RouteResults/shared/AccessibleWaitRow.tsx";

describe("AccessibleWaitRow", () => {
  it("renders 'Wait {n} min at {stop}' for buffer wait", () => {
    const { getByText } = render(<AccessibleWaitRow minutes={3} stopName="Centre Stop" />);
    expect(getByText(/Wait 3 min at Centre Stop/i)).toBeInTheDocument();
  });

  it("renders for transfer wait (same component, different label semantics handled by caller)", () => {
    const { getByText } = render(<AccessibleWaitRow minutes={5} stopName="Junction" />);
    expect(getByText(/Wait 5 min at Junction/i)).toBeInTheDocument();
  });

  it("uses listitem role for screen readers", () => {
    const { getByRole } = render(<AccessibleWaitRow minutes={3} stopName="Centre Stop" />);
    expect(getByRole("listitem")).toBeInTheDocument();
  });
});
