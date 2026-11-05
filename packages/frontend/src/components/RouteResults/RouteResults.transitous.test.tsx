import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

vi.mock("./TransitousPanel.tsx", () => ({
  TransitousPanel: () => <div data-testid="transitous-panel" />,
}));
// This repo uses a local i18n wrapper (src/i18n/index.ts), NOT react-i18next.
vi.mock("../../i18n/index.ts", () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, formattingLocale: "en" }),
}));

import { RouteResults } from "./RouteResults.tsx";

const transitous = { from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 }, departAtIso: "2026-06-26T08:00:00Z", feedTz: "Europe/Vilnius" };

describe("RouteResults transitous wiring", () => {
  const onSelect = () => {};

  it("renders the panel in the empty-state branch", () => {
    render(<RouteResults itineraries={[]} onSelect={onSelect} loading={false} error={null} engineError={null} transitous={transitous} />);
    expect(screen.getByTestId("transitous-panel")).toBeInTheDocument();
  });

  it("renders the panel in the engine-failure branch", () => {
    render(<RouteResults itineraries={[]} onSelect={onSelect} loading={false} error={null} engineError={"wasm boom"} transitous={transitous} />);
    expect(screen.getByTestId("transitous-panel")).toBeInTheDocument();
  });

  it("renders no panel when the standing provider is absent or gated", () => {
    render(<RouteResults itineraries={[]} onSelect={onSelect} loading={false} error={null} engineError={null} />);
    expect(screen.queryByTestId("transitous-panel")).not.toBeInTheDocument();
  });

  it("does NOT offer the panel on the server-empty state (pt-serve answered; no third-party egress)", () => {
    render(<RouteResults itineraries={[]} onSelect={onSelect} loading={false} error={null} engineError={null} serverEmpty={true} transitous={transitous} />);
    expect(screen.getByTestId("server-no-route")).toBeInTheDocument();
    expect(screen.queryByTestId("transitous-panel")).not.toBeInTheDocument();
  });
});
