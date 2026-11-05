import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LeaveHint } from "../../src/components/RouteResults/shared/LeaveHint.tsx";

describe("LeaveHint", () => {
  it("returns null when bufferSeconds === 0", () => {
    const { container } = render(
      <LeaveHint bufferSeconds={0} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("returns null when bufferSeconds rounds to 0 minutes", () => {
    const { container } = render(
      <LeaveHint bufferSeconds={20} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders 'Leave now · 3 min wait at stop' when leadingWait === 0", () => {
    const { getByText } = render(
      <LeaveHint bufferSeconds={180} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} />,
    );
    expect(getByText(/Leave now · 3 min wait at stop/i)).toBeInTheDocument();
  });

  it("renders 'Leave HH:MM · 3 min wait at stop' when leadingWait > 0", () => {
    const refTime = new Date("2026-04-25T10:47:00Z").getTime();
    const { getByText } = render(
      <LeaveHint bufferSeconds={180} leadingWaitSeconds={600} recommendedDepartureMs={refTime} />,
    );
    expect(getByText(/3 min wait at stop/i)).toBeInTheDocument();
    expect(getByText(/Leave/i)).toBeInTheDocument();
  });

  it("tells a rider with no slack to go now, even with the buffer off", () => {
    const { getByText } = render(
      <LeaveHint bufferSeconds={0} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} catchStatus="tight" />,
    );
    expect(getByText(/Leave now · no time to spare at the stop/i)).toBeInTheDocument();
  });

  it("tells a rider who can only make it at a run to hurry", () => {
    const { getByText } = render(
      <LeaveHint bufferSeconds={0} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} catchStatus="hurry" />,
    );
    expect(getByText(/Leave now and hurry · walk fast or run to make it/i)).toBeInTheDocument();
  });

  it("warns a rider who will likely miss it", () => {
    const { getByText } = render(
      <LeaveHint bufferSeconds={0} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} catchStatus="likely-miss" />,
    );
    expect(getByText(/You'll likely miss this departure/i)).toBeInTheDocument();
  });

  it("keeps the buffer hint for an on-time catch", () => {
    const { getByText } = render(
      <LeaveHint bufferSeconds={180} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} catchStatus="on-time" />,
    );
    expect(getByText(/Leave now · 3 min wait at stop/i)).toBeInTheDocument();
  });

  it("offers the next departure to a rider who will likely miss this one", () => {
    const { getByText } = render(
      <LeaveHint bufferSeconds={0} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} catchStatus="likely-miss" nextDepartureInMin={15} />,
    );
    expect(getByText("You'll likely miss this departure · next in ~15 min")).toBeInTheDocument();
  });

  it("says the departure is cancelled, and when the line next leaves", () => {
    const { getByText, rerender } = render(
      <LeaveHint bufferSeconds={180} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} catchStatus="cancelled" nextDepartureInMin={10} />,
    );
    expect(getByText("This departure is cancelled · next in ~10 min")).toBeInTheDocument();
    rerender(<LeaveHint bufferSeconds={180} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} catchStatus="cancelled" />);
    expect(getByText("This departure is cancelled")).toBeInTheDocument();
  });

  it("says a removed departure is no longer scheduled — not cancelled", () => {
    const { getByText, queryByText, rerender } = render(
      <LeaveHint bufferSeconds={180} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} catchStatus="removed" nextDepartureInMin={10} />,
    );
    expect(getByText("No longer scheduled · next in ~10 min")).toBeInTheDocument();
    expect(queryByText(/cancel/i)).toBeNull();
    rerender(<LeaveHint bufferSeconds={180} leadingWaitSeconds={0} recommendedDepartureMs={Date.now()} catchStatus="removed" />);
    expect(getByText("No longer scheduled")).toBeInTheDocument();
  });
});
