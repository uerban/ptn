import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StopMarker } from "../../src/components/Map/StopMarker.tsx";
import {
  STOP_MARKER_CONTAINER_CLASS,
  createStopMarkerElement,
  findMarkerStopId,
} from "../../src/components/Map/markerClickDelegation.ts";

// Tests for the marker-click delegation pattern in TransitMap.
//
// PR #171 attached a `click` listener directly to each per-marker
// `el.addEventListener(...)`, on the assumption the outer container is
// identity-stable across the debounced re-render. In practice
// `marker.remove()` also fires from `updateMarkers`'s winner-cleanup
// branch, detaching the listener whenever a stop transiently leaves
// the buffered viewport during a flyTo or zoom. Playwright surfaces
// this as "element is not stable → element was detached, retrying"
// in `e2e/core/stop-popup.spec.ts`; end users see taps that don't
// open the popup.
//
// These tests cover the small primitives that `TransitMap.updateMarkers`
// and the init useEffect call into: the marker factory (write side)
// and `findMarkerStopId` (read side).

const roots: Root[] = [];
const overlays: HTMLElement[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  for (const overlay of overlays.splice(0)) {
    overlay.remove();
  }
});

describe("createStopMarkerElement", () => {
  it("returns a div tagged with the marker class and data-stop-id", () => {
    const el = createStopMarkerElement("stop-A");
    expect(el.tagName).toBe("DIV");
    expect(el.className).toContain(STOP_MARKER_CONTAINER_CLASS);
    expect(el.className).toContain("cursor-pointer");
    expect(el.dataset.stopId).toBe("stop-A");
    expect(findMarkerStopId(el)).toBe("stop-A");
  });

  it("throws on an empty stopId so an upstream slipup can't produce a silently-untagged marker", () => {
    expect(() => createStopMarkerElement("")).toThrow(/non-empty/);
  });

  it("does not attach an inline click handler — delegation is the contract", () => {
    // The whole point of the factory is that clicks are routed via a
    // parent delegated listener, NOT a per-element one. `el.onclick`
    // is the only listener slot we can introspect from script in
    // jsdom; asserting it stays null catches the obvious regression
    // of adding back the per-marker handler PR #171 had.
    const el = createStopMarkerElement("stop-A");
    expect(el.onclick).toBeNull();
  });
});

describe("findMarkerStopId", () => {
  it("reads back what createStopMarkerElement wrote", () => {
    const el = createStopMarkerElement("stop-A");
    expect(findMarkerStopId(el)).toBe("stop-A");
  });

  it("walks up from a descendant to the marker container", () => {
    // End users click the visible inner card, not the 0x0 outer
    // container. The delegated listener receives the inner card as
    // `event.target`; it must walk up to the `.stop-marker-container`
    // ancestor that carries the stop id.
    const el = createStopMarkerElement("stop-B");
    const inner = document.createElement("div");
    inner.className = "cursor-pointer some-inner";
    el.appendChild(inner);
    const text = document.createElement("span");
    inner.appendChild(text);

    expect(findMarkerStopId(text)).toBe("stop-B");
  });

  it("returns null when the click is outside any marker", () => {
    const el = document.createElement("div");
    el.className = "not-a-marker";
    expect(findMarkerStopId(el)).toBeNull();
    expect(findMarkerStopId(null)).toBeNull();
  });

  it("returns null for a marker missing data-stop-id (untagged) so the delegated handler bails silently", () => {
    // Belt-and-suspenders for the factory's empty-string guard. If
    // someone bypasses the factory and builds a marker with no tag,
    // the read side must still refuse to route a click.
    const untagged = document.createElement("div");
    untagged.className = STOP_MARKER_CONTAINER_CLASS;
    expect(findMarkerStopId(untagged)).toBeNull();
  });
});

describe("Marker click survives detach + re-add (delegation contract)", () => {
  it("the same delegated listener handles clicks on a recreated marker", () => {
    // Reproduces the path PR #171 missed: `marker.remove()` in
    // `updateMarkers`'s winner-cleanup branch detaches the marker el.
    // A per-marker addEventListener vanishes with it. Delegation on
    // a stable parent keeps the click contract intact across
    // detach/recreate cycles, which is the regression we're locking
    // in.
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    overlays.push(parent);

    const onStopClick = vi.fn();
    parent.addEventListener("click", (e) => {
      const stopId = findMarkerStopId(e.target);
      if (stopId) onStopClick(stopId);
    });

    // First marker — like TransitMap's create-path.
    let el = createStopMarkerElement("stop-A");
    parent.appendChild(el);
    let root = createRoot(el);
    roots.push(root);
    act(() => {
      root.render(<StopMarker name="Stop A" offset={{ dx: 40, dy: -30 }} />);
    });

    (el.querySelector(".cursor-pointer") as HTMLElement).click();
    expect(onStopClick).toHaveBeenLastCalledWith("stop-A");

    // Simulate `marker.remove()` — maplibre detaches el from DOM.
    act(() => root.unmount());
    el.remove();
    roots.pop();

    // Recreate the marker with the same id (updateMarkers create-path
    // after a brief viewport-leave + return).
    el = createStopMarkerElement("stop-A");
    parent.appendChild(el);
    root = createRoot(el);
    roots.push(root);
    act(() => {
      root.render(<StopMarker name="Stop A" offset={{ dx: -40, dy: 30 }} />);
    });

    el.click();

    expect(onStopClick).toHaveBeenCalledTimes(2);
    expect(onStopClick).toHaveBeenLastCalledWith("stop-A");
  });
});
