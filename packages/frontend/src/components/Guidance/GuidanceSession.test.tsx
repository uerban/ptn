import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const calls = vi.hoisted(() => ({
  progress: vi.fn(),
  rider: vi.fn(),
  notifications: vi.fn(),
  request: vi.fn(),
}));
const POSITION = { lat: 54.6, lon: 25.2 };
vi.mock("../../hooks/useWatchPosition.ts", () => ({
  useWatchPosition: () => ({ position: POSITION, speed: 3 }),
}));
vi.mock("../../hooks/useGuidanceLegProgress.ts", () => ({ useGuidanceLegProgress: calls.progress }));
vi.mock("../../hooks/useRiderModeDetection.ts", () => ({ useRiderModeDetection: calls.rider }));
vi.mock("../../hooks/useTripNotifications.ts", () => ({ useTripNotifications: calls.notifications }));
vi.mock("../../services/liveLocation.ts", () => ({ liveLocation: { request: calls.request } }));
vi.mock("../../hooks/useGuidanceDashboard.ts", () => ({
  useGuidanceDashboard: () => ({ currentLeg: null, upcomingStops: [{ id: "u1" }], connectingDepartures: [] }),
}));

import { GuidanceSessionProvider, useGuidanceSession } from "./GuidanceSession.tsx";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";

function Reader({ id }: { id: string }) {
  const session = useGuidanceSession();
  return <span data-testid={id}>{session.upcomingStops.length}</span>;
}

beforeEach(() => {
  vi.clearAllMocks();
  useGuidanceStore.getState().stopNavigation();
});

describe("GuidanceSessionProvider", () => {
  it("runs the progress hooks once for every surface under it", () => {
    render(
      <GuidanceSessionProvider>
        <Reader id="text" />
        <Reader id="map" />
      </GuidanceSessionProvider>,
    );
    expect(calls.progress).toHaveBeenCalledTimes(1);
    expect(calls.progress).toHaveBeenCalledWith(POSITION, 3);
    expect(calls.rider).toHaveBeenCalledWith(POSITION, 3);
    expect(calls.notifications).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("text").textContent).toBe("1");
    expect(screen.getByTestId("map").textContent).toBe("1");
  });

  it("asks for live location only while a trip is on", () => {
    render(<GuidanceSessionProvider><Reader id="x" /></GuidanceSessionProvider>);
    expect(calls.request).not.toHaveBeenCalled();
  });

  it("is idle outside the provider", () => {
    render(<Reader id="outside" />);
    expect(screen.getByTestId("outside").textContent).toBe("0");
  });
});
