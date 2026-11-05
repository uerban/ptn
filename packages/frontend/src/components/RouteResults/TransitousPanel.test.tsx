import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";

const runMock = vi.fn();
let mockState: unknown = { status: "idle" };
vi.mock("../../hooks/useTransitous.ts", () => ({
  useTransitous: () => ({ state: mockState, run: runMock }),
}));
// This repo uses a local i18n wrapper (src/i18n/index.ts), NOT react-i18next.
// Its `t` takes a plain string fallback; mirror VersionBlock.test.tsx's idiom.
vi.mock("../../i18n/index.ts", () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k, formattingLocale: "en" }),
}));

import { TransitousPanel } from "./TransitousPanel.tsx";

const props = { from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 }, departAtIso: "2026-06-26T08:00:00Z", feedTz: "Europe/Vilnius" };
beforeEach(() => { runMock.mockClear(); mockState = { status: "idle" }; });

describe("TransitousPanel", () => {
  it("dispatches through the standing provider without a Try interruption", () => {
    render(<TransitousPanel {...props} />);
    expect(screen.queryByTestId("transitous-try")).not.toBeInTheDocument();
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ from: { lat: 1, lon: 2 } }));
  });

  it("dispatches again when the standing query changes", () => {
    const { rerender } = render(<TransitousPanel {...props} />);
    rerender(
      <TransitousPanel {...props} to={{ lat: 5, lon: 6 }} />,
    );
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(runMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: { lat: 5, lon: 6 } }),
    );
  });

  it("renders the empty / failure / offline states", () => {
    mockState = { status: "done", outcome: { kind: "empty" } };
    const { rerender } = render(<TransitousPanel {...props} />);
    expect(screen.getByTestId("transitous-empty")).toBeInTheDocument();
    mockState = { status: "done", outcome: { kind: "failure" } };
    rerender(<TransitousPanel {...props} />);
    expect(screen.getByTestId("transitous-failure")).toBeInTheDocument();
    mockState = { status: "done", outcome: { kind: "offline" } };
    rerender(<TransitousPanel {...props} />);
    expect(screen.getByTestId("transitous-offline")).toBeInTheDocument();
  });

  it("offers a working retry on failure/offline that re-fires the query", () => {
    mockState = { status: "done", outcome: { kind: "failure" } };
    render(<TransitousPanel {...props} />);
    fireEvent.click(screen.getByTestId("transitous-retry"));
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ from: { lat: 1, lon: 2 } }));
  });

  it("signals on-device fallback after a remote-primary transport failure", () => {
    const onFallback = vi.fn();
    const { rerender } = render(
      <TransitousPanel {...props} onFallback={onFallback} />,
    );
    mockState = { status: "pending" };
    rerender(<TransitousPanel {...props} onFallback={onFallback} />);
    mockState = { status: "done", outcome: { kind: "failure" } };
    rerender(<TransitousPanel {...props} onFallback={onFallback} />);
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it("does not apply the previous query's failure to a new query", () => {
    const onFallback = vi.fn();
    const { rerender } = render(
      <TransitousPanel {...props} onFallback={onFallback} />,
    );
    mockState = { status: "pending" };
    rerender(<TransitousPanel {...props} onFallback={onFallback} />);
    mockState = { status: "done", outcome: { kind: "failure" } };
    rerender(<TransitousPanel {...props} onFallback={onFallback} />);
    expect(onFallback).toHaveBeenCalledOnce();

    rerender(
      <TransitousPanel
        {...props}
        to={{ lat: 5, lon: 6 }}
        onFallback={onFallback}
      />,
    );
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it("does NOT offer a retry on the reachable-but-empty state", () => {
    mockState = { status: "done", outcome: { kind: "empty" } };
    render(<TransitousPanel {...props} />);
    expect(screen.queryByTestId("transitous-retry")).not.toBeInTheDocument();
  });

  it("renders the results as a faithful text leg-list", () => {
    mockState = { status: "done", outcome: { kind: "results", itineraries: [{
      legs: [{ mode: "BUS", fromName: "A", toName: "B", fromLoc: { lat: 1, lon: 2 }, toLoc: { lat: 3, lon: 4 },
               departIso: "2026-06-26T08:00:00Z", arriveIso: "2026-06-26T08:05:00Z",
               routeShortName: "42", path: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] }],
      departIso: "2026-06-26T08:00:00Z", arriveIso: "2026-06-26T08:05:00Z",
      durationSeconds: 300, transfers: 0, walkingDistanceMeters: 0 }] } };
    render(<TransitousPanel {...props} />);
    expect(screen.getByTestId("transitous-results")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders leg times in the FEED tz, not the device tz", () => {
    // 08:00Z in summer Europe/Vilnius (EEST, UTC+3) ⇒ 11:00. fmtTime passes an
    // explicit `timeZone`, so this is deterministic regardless of the runner's
    // TZ — guarding the cross-tz headline the feature exists for.
    mockState = { status: "done", outcome: { kind: "results", itineraries: [{
      legs: [{ mode: "BUS", fromName: "A", toName: "B", fromLoc: { lat: 1, lon: 2 }, toLoc: { lat: 3, lon: 4 },
               departIso: "2026-06-26T08:00:00Z", arriveIso: "2026-06-26T08:30:00Z",
               routeShortName: "42", path: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] }],
      departIso: "2026-06-26T08:00:00Z", arriveIso: "2026-06-26T08:30:00Z",
      durationSeconds: 1800, transfers: 0, walkingDistanceMeters: 0 }] } };
    render(<TransitousPanel {...props} />);
    expect(screen.getByTestId("transitous-results")).toHaveTextContent(/11:00/);
    expect(screen.getByTestId("transitous-results")).toHaveTextContent(/11:30/);
  });

  it("falls back to a mode label when a leg has no route short-name", () => {
    mockState = { status: "done", outcome: { kind: "results", itineraries: [{
      legs: [{ mode: "WALK", fromName: "A", toName: "B", fromLoc: { lat: 1, lon: 2 }, toLoc: { lat: 3, lon: 4 },
               departIso: "2026-06-26T08:00:00Z", arriveIso: "2026-06-26T08:05:00Z",
               path: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] }],
      departIso: "2026-06-26T08:00:00Z", arriveIso: "2026-06-26T08:05:00Z",
      durationSeconds: 300, transfers: 0, walkingDistanceMeters: 200 }] } };
    render(<TransitousPanel {...props} />);
    // The i18n mock returns the fallback (the mode string) for the mode.* key.
    expect(screen.getByTestId("transitous-results")).toHaveTextContent("WALK");
  });
});
