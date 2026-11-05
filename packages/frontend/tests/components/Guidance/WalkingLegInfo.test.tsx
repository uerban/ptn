import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WalkingLegInfo } from "../../../src/components/Guidance/WalkingLegInfo.tsx";
import { walkStepText } from "../../../src/utils/walkStepText.ts";

const base = { distanceRemainingMeters: 176, estimatedSecondsRemaining: 140, bearingDegrees: 90 };
const t = (_k: string, f?: string) => f ?? _k;

describe("WalkingLegInfo", () => {
  it("shows the next instruction instead of the compass hint", () => {
    const nextStep = { kind: "cross" as const, turn: "left", name: "", distanceToStartMeters: 64 };
    render(<WalkingLegInfo progress={{ ...base, nextStep }} />);
    expect(screen.getByTestId("walk-next-step").textContent).toBe("64 m · Turn left · Cross the street");
    expect(screen.queryByText(/^Walk/)).toBeNull();
    expect(screen.getByText("176 m")).toBeTruthy();
  });

  it("reads the street name as part of the same line", () => {
    const nextStep = { kind: "turn" as const, turn: "right", name: "Pylimo g.", distanceToStartMeters: 42 };
    render(<WalkingLegInfo progress={{ ...base, nextStep }} />);
    const line = screen.getByTestId("walk-next-step").textContent;
    expect(line).toBe("42 m · Turn right · Pylimo g.");
    expect(line).toBe(walkStepText(t, nextStep));
  });

  it("keeps the compass hint without a walk-graph route", () => {
    render(<WalkingLegInfo progress={base} />);
    expect(screen.queryByTestId("walk-next-step")).toBeNull();
    expect(screen.getByText(/^Walk/)).toBeTruthy();
  });
});
