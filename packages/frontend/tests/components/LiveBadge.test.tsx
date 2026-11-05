import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { LiveBadge } from "../../src/components/RouteResults/shared/LiveBadge.tsx";

describe("LiveBadge sizes", () => {
  it.each(["sm", "md", "lg"] as const)(
    "renders without throwing at size=%s",
    (size) => {
      const { container } = render(
        <LiveBadge delaySeconds={0} size={size} />,
      );
      expect(container.firstChild).toBeInTheDocument();
    },
  );

  it("consumer (md) variant: no border chrome — colored text + pulse", () => {
    const { container } = render(<LiveBadge delaySeconds={120} size="md" />);
    expect(container.firstChild).not.toHaveClass("rounded", "border");
  });

  it("power (sm) variant: hard-bordered pill", () => {
    const { container } = render(<LiveBadge delaySeconds={120} size="sm" />);
    expect(container.firstChild).toHaveClass("rounded", "border");
  });

  it("accessible (lg) variant: tinted background + underline treatment", () => {
    const { container } = render(<LiveBadge delaySeconds={120} size="lg" />);
    const style = (container.firstChild as HTMLElement).getAttribute("style") ?? "";
    expect(style).toMatch(/border-bottom/i);
  });
});
