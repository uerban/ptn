import { describe, it, expect } from "vitest";
import {
  solveLabels,
  diffDimmed,
  cardCenter,
  translatePageRectToCanvas,
  type LabelDot,
  type SolveInput,
} from "../../src/components/Map/cardPlacement.ts";

function dot(id: string, x: number, y: number, lineCount = 1, w = 80, h = 36): LabelDot {
  return { id, x, y, w, h, lineCount };
}

function baseInput(dots: LabelDot[], over: Partial<SolveInput> = {}): SolveInput {
  return {
    dots,
    obstacles: [],
    viewport: { w: 1000, h: 800 },
    prev: new Map(),
    hardHide: true, // exercise the hide-mode guarantees unless a test overrides
    ...over,
  };
}

// Replicate StopMarker's anchor convention to assert parity (cardRect).
function markerCenter(d: LabelDot, dx: number, dy: number) {
  const sx = dx > 0.5 ? d.w / 2 : dx < -0.5 ? -d.w / 2 : 0;
  const sy = dy > 0.5 ? d.h / 2 : dy < -0.5 ? -d.h / 2 : 0;
  return { cx: d.x + dx + sx, cy: d.y + dy + sy };
}

function rectOf(d: LabelDot, off: { dx: number; dy: number }) {
  const c = markerCenter(d, off.dx, off.dy);
  return { left: c.cx - d.w / 2, right: c.cx + d.w / 2, top: c.cy - d.h / 2, bottom: c.cy + d.h / 2 };
}
function overlaps(a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

describe("solveLabels — no overlaps (test 1)", () => {
  it("produces zero overlapping cards on a dense cluster", () => {
    const dots: LabelDot[] = [];
    for (let i = 0; i < 12; i++) dots.push(dot(`s${i}`, 500 + (i % 4) * 18, 400 + Math.floor(i / 4) * 18));
    const { offsets, metrics } = solveLabels(baseInput(dots));
    expect(metrics.overlaps).toBe(0);
    const placed = [...offsets.entries()].map(([id, off]) => rectOf(dots.find((d) => d.id === id)!, off));
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++)
        expect(overlaps(placed[i], placed[j])).toBe(false);
  });
});

describe("solveLabels — stable across a pan (test 2)", () => {
  it("reuses every offset and reports zero shifts when all dots translate by a constant", () => {
    const dots = [dot("a", 200, 200), dot("b", 600, 300, 2), dot("c", 400, 500)];
    const first = solveLabels(baseInput(dots));
    const panned = dots.map((d) => ({ ...d, x: d.x + 37, y: d.y - 22 }));
    const second = solveLabels(baseInput(panned, { prev: first.offsets }));
    expect(second.metrics.shifts).toBe(0);
    for (const [id, off] of second.offsets) {
      const p = first.offsets.get(id)!;
      expect(off).toEqual(p);
    }
  });
});

describe("solveLabels — hysteresis (tests 3 & 4)", () => {
  it("reuses a clean prev offset within 60px unchanged (test 3)", () => {
    const dots = [dot("a", 300, 300)];
    const prev = new Map([["a", { dx: 30, dy: 0 }]]);
    const { offsets } = solveLabels(baseInput(dots, { prev }));
    expect(offsets.get("a")).toEqual({ dx: 30, dy: 0 });
  });

  it("re-scans a stretched prev offset >60px so it can relax inward (test 4)", () => {
    const dots = [dot("a", 300, 300)];
    const prev = new Map([["a", { dx: 110, dy: 0 }]]); // hypot 110 > 60
    const { offsets } = solveLabels(baseInput(dots, { prev }));
    const got = offsets.get("a")!;
    expect(Math.hypot(got.dx, got.dy)).toBeLessThan(110);
  });

  it("re-scans an edge-entry offset whose card is outside the viewport", () => {
    const d = dot("a", 50, 300, 1, 80, 36);
    // Within the 60px hysteresis radius, but the negative anchor puts the
    // 80px-wide card beyond the left edge after the dot enters the canvas.
    const prev = new Map([["a", { dx: -30, dy: 0 }]]);
    const { offsets } = solveLabels(baseInput([d], { prev }));
    const got = offsets.get("a")!;

    expect(got).not.toEqual(prev.get("a"));
    const rect = rectOf(d, got);
    expect(rect.left).toBeGreaterThanOrEqual(6);
    expect(rect.right).toBeLessThanOrEqual(994);
  });
});

describe("solveLabels — hard hide + kill-switch (test 5)", () => {
  // Stack many large cards on nearly the same point so most cannot find a clean spot.
  function pile(): LabelDot[] {
    const dots: LabelDot[] = [];
    for (let i = 0; i < 14; i++) dots.push(dot(`p${i}`, 500 + (i % 2), 400 + (i % 2), 1, 140, 44));
    return dots;
  }

  it("hides some labels and never hides the selected one (hardHide=true)", () => {
    const dots = pile();
    const { hidden } = solveLabels(baseInput(dots, { selectedId: "p7" }));
    expect(hidden.size).toBeGreaterThan(0);
    expect(hidden.has("p7")).toBe(false);
  });

  it("hides nothing when the kill-switch is off (hardHide=false)", () => {
    const dots = pile();
    const { hidden, offsets } = solveLabels(baseInput(dots, { hardHide: false }));
    expect(hidden.size).toBe(0);
    expect(offsets.size).toBe(dots.length);
  });
});

describe("cardCenter — anchoring parity (test 6)", () => {
  it("matches StopMarker's tx/ty convention across all anchor quadrants", () => {
    const x = 400, y = 400, w = 80, h = 36;
    const cases = [
      { dx: 30, dy: 0 }, { dx: -30, dy: 0 }, { dx: 0, dy: 30 }, { dx: 0, dy: -30 },
      { dx: 0, dy: 0 }, { dx: 30, dy: 30 }, { dx: -30, dy: -30 },
    ];
    for (const { dx, dy } of cases) {
      const got = cardCenter(x, y, w, h, dx, dy);
      const want = markerCenter({ id: "a", x, y, w, h, lineCount: 1 }, dx, dy);
      expect(got).toEqual(want);
    }
  });
});

describe("solveLabels — stale-size reuse discarded (test 8)", () => {
  it("re-scans (does not reuse) a prev offset whose card grew into a neighbor", () => {
    // a is placed first (more lines); b's tiny prev offset would now overlap a once b's card is large.
    const a = dot("a", 400, 400, 5, 80, 36);
    const b = dot("b", 470, 400, 1, 140, 80); // large card; prev was sized small
    const prev = new Map([["b", { dx: -14, dy: 0 }]]); // points back toward a → overlaps once big
    const { offsets, metrics } = solveLabels(baseInput([a, b], { prev }));
    expect(metrics.overlaps).toBe(0);
    // b must have moved off its stale prev
    expect(offsets.get("b")).not.toEqual({ dx: -14, dy: 0 });
  });
});

describe("solveLabels — metric honesty (test 9)", () => {
  it("reports overlaps > 0 when labels are forced to overlap (kill-switch off)", () => {
    // A dense pile of large cards with hardHide OFF: every label is placed
    // (never hidden), so some MUST overlap — and the metric must report it.
    // (Two cards alone can always be split left/right by the offset, so a pile
    // is required to force a real overlap.)
    const dots: LabelDot[] = [];
    for (let i = 0; i < 14; i++) dots.push(dot(`q${i}`, 500 + (i % 2), 400 + (i % 2), 1, 140, 44));
    const { hidden, metrics } = solveLabels(baseInput(dots, { hardHide: false }));
    expect(hidden.size).toBe(0);
    expect(metrics.overlaps).toBeGreaterThan(0);
  });
});

describe("translatePageRectToCanvas (unchanged)", () => {
  it("subtracts the canvas page-space origin", () => {
    const out = translatePageRectToCanvas(
      { left: 100, top: 50, right: 180, bottom: 90 },
      { left: 20, top: 10 },
    );
    expect(out).toEqual({ left: 80, top: 40, right: 160, bottom: 80 });
  });

  it("is the identity when the canvas origin is at the page origin", () => {
    const rect = { left: 100, top: 50, right: 180, bottom: 90 };
    expect(translatePageRectToCanvas(rect, { left: 0, top: 0 })).toEqual(rect);
  });
});

describe("solveLabels — Stage 2 dormant when hints absent (test 10)", () => {
  // Captured from the pre-Stage-2 solver over a hint-less multi-dot input.
  // If Stage 2's scoring term or curb-cone attempt perturbs the Stage-1 path, this
  // breaks. The 13 Stage-1 tests above are the broader dormancy proof; this is
  // the explicit byte-identical pin.
  const DOTS_FOR_BASELINE: LabelDot[] = [
    dot("a", 200, 200, 1),
    dot("b", 240, 210, 2),
    dot("c", 220, 250, 1),
    dot("d", 280, 240, 3),
    dot("e", 260, 200, 1),
  ];
  function baselineInput(): SolveInput {
    return {
      dots: DOTS_FOR_BASELINE.map((d) => ({ ...d })),
      obstacles: [{ left: 300, top: 300, right: 360, bottom: 340 }],
      viewport: { w: 1000, h: 800 },
      prev: new Map(),
      hardHide: true,
    };
  }
  const EXPECTED_OFFSETS: Record<string, { dx: number; dy: number }> = {
    a: { dx: -3.623466631435292, dy: 13.522961568046956 },
    b: { dx: -16.970562748477143, dy: -16.97056274847714 },
    c: { dx: 7.000000000000002, dy: 12.12435565298214 },
    d: { dx: 14, dy: 0 },
    e: { dx: 14, dy: 0 },
  };

  it("returns byte-identical offsets/hidden/metrics to the captured Stage-1 baseline", () => {
    const r = solveLabels(baselineInput());
    const got: Record<string, { dx: number; dy: number }> = {};
    for (const [id, off] of r.offsets) got[id] = off;
    expect(got).toEqual(EXPECTED_OFFSETS);
    expect([...r.hidden]).toEqual([]);
    expect(r.metrics).toEqual({ overlaps: 0, shifts: 0, hideFlips: 0 });
  });

  it("is deterministic — two identical hint-less runs agree exactly", () => {
    const first = solveLabels(baselineInput());
    const second = solveLabels(baselineInput());
    const a: Record<string, { dx: number; dy: number }> = {};
    const b: Record<string, { dx: number; dy: number }> = {};
    for (const [id, off] of first.offsets) a[id] = off;
    for (const [id, off] of second.offsets) b[id] = off;
    expect(b).toEqual(a);
    expect([...second.hidden].sort()).toEqual([...first.hidden].sort());
    expect(second.metrics).toEqual(first.metrics);
  });
});

describe("solveLabels — Stage 2 road-side bias (test 11)", () => {
  it("biases a lone dot's card toward the curb side direction", () => {
    // The road term penalizes directions pointing AWAY from `side`; it leaves the
    // whole non-away hemisphere (incl. perpendicular) untouched. To make the bias
    // decisive we narrow the viewport so only the vertical axis is clean: a card
    // pushed left/right runs off-screen (heavy outView). side points up (dy:-1),
    // so the up placement (dy<0, road=0) must beat the down placement (dy>0,
    // road=W.road). Without the term the down/up offsets tie and DIRS order picks
    // the +x/horizontal escape — the assertion below would not hold.
    const d: LabelDot = { id: "a", x: 60, y: 300, w: 80, h: 36, lineCount: 1, side: { dx: 0, dy: -1 } };
    const { offsets } = solveLabels(baseInput([d], { viewport: { w: 120, h: 800 } }));
    const off = offsets.get("a")!;
    expect(off.dy).toBeLessThan(0);
  });

  it("is the away direction when side flips (dy:+1 → card below)", () => {
    const d: LabelDot = { id: "a", x: 60, y: 300, w: 80, h: 36, lineCount: 1, side: { dx: 0, dy: 1 } };
    const { offsets } = solveLabels(baseInput([d], { viewport: { w: 120, h: 800 } }));
    const off = offsets.get("a")!;
    expect(off.dy).toBeGreaterThan(0);
  });
});

describe("solveLabels — Stage 2 curb-side cone (test 12)", () => {
  it("splits two paired dots to opposite curb sides", () => {
    const a: LabelDot = { id: "a", x: 400, y: 400, w: 80, h: 36, lineCount: 1, pinToSide: true, side: { dx: 0, dy: 1 } };
    const b: LabelDot = { id: "b", x: 400, y: 400, w: 80, h: 36, lineCount: 1, pinToSide: true, side: { dx: 0, dy: -1 } };
    const { offsets } = solveLabels(baseInput([a, b]));
    const oa = offsets.get("a")!;
    const ob = offsets.get("b")!;
    expect(oa.dy).toBeGreaterThan(0); // a's side is +y → card below
    expect(ob.dy).toBeLessThan(0); // b's side is -y → card above
  });

  it("does not pin an entering stop's card off-screen along its curb side", () => {
    const d: LabelDot = {
      id: "edge",
      x: 300,
      y: 770,
      w: 120,
      h: 44,
      lineCount: 8,
      pinToSide: true,
      side: { dx: 0, dy: 1 },
    };
    const { offsets } = solveLabels(baseInput([d]));
    const rect = rectOf(d, offsets.get("edge")!);

    expect(rect.top).toBeGreaterThanOrEqual(6);
    expect(rect.bottom).toBeLessThanOrEqual(794);
  });

  it("pins an unpaired line-aware stop to its clean curb side", () => {
    const d: LabelDot = {
      id: "platform",
      x: 400,
      y: 400,
      w: 100,
      h: 44,
      lineCount: 3,
      pinToSide: true,
      side: { dx: 1, dy: 0 },
    };

    expect(solveLabels(baseInput([d])).offsets.get("platform")).toEqual({
      dx: 14,
      dy: 0,
    });
  });

  it("does not reuse a clean Stage-1 offset outside the newly-arrived curb cone", () => {
    const d: LabelDot = {
      id: "async-hint",
      x: 400,
      y: 400,
      w: 100,
      h: 44,
      lineCount: 3,
      pinToSide: true,
      side: { dx: 1, dy: 0 },
    };
    const prev = new Map([[d.id, { dx: 0, dy: -30 }]]);
    const off = solveLabels(baseInput([d], { prev })).offsets.get(d.id)!;

    expect(off).not.toEqual(prev.get(d.id));
    expect(off.dx / Math.hypot(off.dx, off.dy)).toBeGreaterThanOrEqual(Math.cos(Math.PI / 6));
  });

  it("keeps on-screen stops ahead of higher-line-count buffered stops", () => {
    const buffered: LabelDot = {
      id: "buffered",
      x: 400,
      y: 400,
      w: 100,
      h: 44,
      lineCount: 99,
      onscreen: false,
      pinToSide: true,
      side: { dx: 1, dy: 0 },
    };
    const visible: LabelDot = {
      id: "visible",
      x: 400,
      y: 400,
      w: 100,
      h: 44,
      lineCount: 1,
      onscreen: true,
    };

    expect([...solveLabels(baseInput([buffered, visible])).offsets.keys()][0]).toBe("visible");
  });

  it("uses an adjacent curb-cone angle when the exact ray is obstructed", () => {
    const d: LabelDot = {
      id: "angled",
      x: 400,
      y: 400,
      w: 80,
      h: 36,
      lineCount: 1,
      pinToSide: true,
      side: { dx: 1, dy: 0 },
    };
    const off = solveLabels(baseInput([d], {
      obstacles: [{ left: 410, top: 380, right: 500, bottom: 401 }],
    })).offsets.get(d.id)!;

    expect(Math.hypot(off.dx, off.dy)).toBeCloseTo(14);
    expect(off.dx).toBeGreaterThan(0);
    expect(off.dy).toBeGreaterThan(0);
  });

  it("never lets a curb candidate cover another stop dot", () => {
    const platform: LabelDot = {
      id: "platform",
      x: 400,
      y: 400,
      w: 100,
      h: 44,
      lineCount: 5,
      pinToSide: true,
      side: { dx: 1, dy: 0 },
    };
    const neighbor = dot("neighbor", 430, 400);
    const off = solveLabels(baseInput([platform, neighbor])).offsets.get(platform.id)!;
    const rect = rectOf(platform, off);

    expect(neighbor.x <= rect.left - 5 || neighbor.x >= rect.right + 5 ||
      neighbor.y <= rect.top - 5 || neighbor.y >= rect.bottom + 5).toBe(true);
  });

  it("bounds every connector to 64px", () => {
    const dots = Array.from({ length: 14 }, (_, i) =>
      dot(`bounded-${i}`, 500 + (i % 2), 400 + (i % 2), 1, 140, 44));
    const { offsets } = solveLabels(baseInput(dots, { hardHide: false }));

    for (const off of offsets.values()) {
      expect(Math.hypot(off.dx, off.dy)).toBeLessThanOrEqual(64.000_001);
    }
  });
});

describe("diffDimmed (test 7)", () => {
  it("sets newly hidden ids and clears ids that left the hidden set", () => {
    const prevDimmed = new Set(["a", "b", "c"]); // c will leave the viewport entirely
    const nextHidden = new Set(["a", "d"]); // d newly hidden; b became visible; c gone
    const { toSet, toClear } = diffDimmed(prevDimmed, nextHidden);
    expect([...toSet].sort()).toEqual(["d"]); // only ids not already dimmed
    expect([...toClear].sort()).toEqual(["b", "c"]); // every prev-dimmed id no longer hidden
  });

  it("is a no-op when nothing changed", () => {
    const s = new Set(["x", "y"]);
    const { toSet, toClear } = diffDimmed(new Set(s), new Set(s));
    expect(toSet).toEqual([]);
    expect(toClear).toEqual([]);
  });
});
