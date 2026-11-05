import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const planMock = vi.fn();
vi.mock("../services/transitousClient.ts", () => ({ planViaTransitous: (...a: unknown[]) => planMock(...a) }));
const telemetryMock = vi.fn();
vi.mock("../services/errorReporter.ts", () => ({ reportTelemetry: (...a: unknown[]) => telemetryMock(...a) }));
vi.mock("../stores/privacyStore.ts", () => ({ getPolicy: () => ({ errorReporting: true }) }));
const onlineMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("./useConnectivity.ts", () => ({ isDeviceOnline: () => onlineMock() }));
// Stub the routingSource module so the hook's `instanceof RoutingNotAllowedError`
// check resolves against a lightweight class (avoids pulling the engine-dispatch
// transitive import into this hook test). The class the hook imports IS the one
// the test throws, so instanceof holds.
vi.mock("../services/routingSource.ts", () => ({
  RoutingNotAllowedError: class RoutingNotAllowedError extends Error {},
}));

import { useTransitous } from "./useTransitous.ts";

afterEach(() => { vi.clearAllMocks(); onlineMock.mockReturnValue(true); });
const args = { from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 }, departAtIso: "2026-06-26T08:00:00Z" };

describe("useTransitous", () => {
  it("idle -> pending -> done(results) and reports telemetry by outcome", async () => {
    planMock.mockResolvedValue({ itineraries: [{ legs: [{
      mode: "BUS", from: { name: "A", location: { lat: 1, lon: 2 } },
      to: { name: "B", location: { lat: 3, lon: 4 } },
      departureTime: "2026-06-26T08:00:00Z", arrivalTime: "2026-06-26T08:05:00Z", durationSeconds: 300,
    }], departureTime: "2026-06-26T08:00:00Z", arrivalTime: "2026-06-26T08:05:00Z",
       durationSeconds: 300, transfers: 0, walkingDistanceMeters: 0 }] });
    const { result } = renderHook(() => useTransitous());
    expect(result.current.state.status).toBe("idle");
    act(() => { void result.current.run(args); });
    await waitFor(() => expect(result.current.state.status).toBe("done"));
    expect(result.current.state).toMatchObject({ status: "done", outcome: { kind: "results" } });
    expect(telemetryMock).toHaveBeenCalledWith("transitous_action", { outcome: "results" });
  });

  it("maps a thrown HttpError to a failure outcome", async () => {
    const { HttpError } = await import("../services/api.ts");
    planMock.mockRejectedValue(new HttpError(502, "up"));
    const { result } = renderHook(() => useTransitous());
    act(() => { void result.current.run(args); });
    await waitFor(() => expect(result.current.state.status).toBe("done"));
    expect(result.current.state).toMatchObject({ outcome: { kind: "failure" } });
  });

  it("classifies a transport reject while the device is offline as the offline outcome", async () => {
    onlineMock.mockReturnValue(false);
    planMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useTransitous());
    act(() => { void result.current.run(args); });
    await waitFor(() => expect(result.current.state.status).toBe("done"));
    expect(result.current.state).toMatchObject({ outcome: { kind: "offline" } });
  });

  it("resets to idle (NOT a 'failure') and fires no telemetry when the call-time gate refuses egress", async () => {
    const { RoutingNotAllowedError } = await import("../services/routingSource.ts");
    planMock.mockRejectedValue(new RoutingNotAllowedError());
    const { result } = renderHook(() => useTransitous());
    act(() => { void result.current.run(args); });
    await waitFor(() => expect(result.current.state).toEqual({ status: "idle" }));
    expect(telemetryMock).not.toHaveBeenCalled();
  });
});
