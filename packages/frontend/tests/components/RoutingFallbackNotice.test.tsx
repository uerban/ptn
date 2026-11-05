import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { RoutingFallbackNotice } from "../../src/components/RoutingFallbackNotice.tsx";

// Minimal i18n: the component uses t(key, fallback) — the English fallback is
// returned when no provider is mounted, which is what these assertions check.
describe("RoutingFallbackNotice", () => {
  it("renders nothing when signal is null", () => {
    const { container } = render(<RoutingFallbackNotice signal={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the offline-fallback copy", () => {
    render(<RoutingFallbackNotice signal="fallback-offline" />);
    expect(screen.getByTestId("routing-fallback-notice")).toHaveTextContent("Offline — showing on-device routes");
  });

  it("renders the server-fallback copy", () => {
    render(<RoutingFallbackNotice signal="fallback-server" />);
    expect(screen.getByTestId("routing-fallback-notice")).toHaveTextContent("Server unavailable — showing on-device routes");
  });
});
