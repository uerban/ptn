/* ============================================================================
   cardPlacement.ts — batch stop-CARD label placement solver.

   Ported from the validated prototype `placement.js` (Vilnius Label Lab) in its
   STABLE config. Returns pixel offsets from each stop dot to the card's near
   edge, matching StopMarker's anchoring (card extends away from the dot).

   Spec: the stop card placement stage1 solver core notes
   Several details are VERBATIM-SENSITIVE (a tidy refactor changes results):
     - coverDot self-skip is by pixel coincidence (|Δ|<1), NOT id, with a ±5px
       dot rect.
     - the hysteresis reuse check is a NARROWER "clean" than the scan's (no
       coverDot; and viewport is intentionally excluded — buffered off-screen
       stability).
     - the greedy early-out breaks the inner dist loop ONLY.
     - the id tie-break is JS string `<` (never localeCompare).
   ============================================================================ */

export interface ObstacleRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Convert a page-space rect (e.g. from `getBoundingClientRect()`) into
 * canvas-relative coordinates by subtracting the canvas's page-space origin.
 */
export function translatePageRectToCanvas(
  rect: ObstacleRect,
  canvasOrigin: { left: number; top: number },
): ObstacleRect {
  return {
    left: rect.left - canvasOrigin.left,
    top: rect.top - canvasOrigin.top,
    right: rect.right - canvasOrigin.left,
    bottom: rect.bottom - canvasOrigin.top,
  };
}

export interface LabelDot {
  /** OPAQUE placeable id (a stop id in Stage 1; a cluster id in later stages). */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lineCount: number;
  /** True when the stop dot is inside the canvas (buffered stops are false). */
  onscreen?: boolean;
  /* ---- Stage 2 road-awareness hints (all OPTIONAL — absent ⇒ Stage-1 behavior).
     Populated by a later task; this solver consumes them only when present. ---- */
  /**
   * SCREEN-space unit curb direction (the side of the road the card should sit
   * on). The geographic normal → screen conversion (with the north-up y-flip)
   * happens upstream — this is already in solver px space.
   */
  side?: { dx: number; dy: number };
  /** Try a bounded curb-side cone before the general 360° scan. */
  pinToSide?: boolean;
}

export interface Offset {
  dx: number;
  dy: number;
}

export interface SolveInput {
  dots: LabelDot[];
  obstacles: ObstacleRect[];
  viewport: { w: number; h: number };
  prev: Map<string, Offset>;
  selectedId?: string;
  /** Kill-switch: when false (default), no label is hidden — overlaps allowed. */
  hardHide?: boolean;
}

export interface SolveResult {
  offsets: Map<string, Offset>;
  hidden: Set<string>;
  metrics: { overlaps: number; shifts: number; hideFlips: number };
}

const RAD = Math.PI / 180;
const DIRS: [number, number][] = [];
for (let a = 0; a < 360; a += 15) DIRS.push([Math.cos(a * RAD), Math.sin(a * RAD)]);

const D_MIN = 14;
/** Bound connector length; dense hubs must hide/aggregate rather than run away. */
const D_MAX = 64;
const D_STEP = 10;
const HYSTERESIS_MAX = 60;
const PAD = 4;
const VP_INSET = 6;
const CURB_CONE_DEGREES = [0, 15, -15, 30, -30] as const;
const CURB_CONE_MIN_DOT = Math.cos(30 * RAD);

const W = {
  cardOverlap: 1400,
  outView: 900,
  obstacle: 650,
  coverDot: 160,
  dist: 1.4,
  stick: 0.9,
  // Stage 2: penalty for a candidate direction pointing AWAY from the curb side.
  // Only added when dot.side is present (else the scoring path is untouched).
  road: 200,
};

interface AABB {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Rect extends AABB {
  cx: number;
  cy: number;
}

/** Card rect for an offset; near edge sits at dot+offset, extends away from the dot. */
function cardRect(x: number, y: number, w: number, h: number, dx: number, dy: number): Rect {
  const sx = dx > 0.5 ? w / 2 : dx < -0.5 ? -w / 2 : 0;
  const sy = dy > 0.5 ? h / 2 : dy < -0.5 ? -h / 2 : 0;
  const cx = x + dx + sx;
  const cy = y + dy + sy;
  return { cx, cy, left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2 };
}

/**
 * Card center for an offset — the StopMarker `tx/ty` anchoring convention.
 * Exported so a unit test can pin parity with `StopMarker`'s render math.
 */
export function cardCenter(
  x: number,
  y: number,
  w: number,
  h: number,
  dx: number,
  dy: number,
): { cx: number; cy: number } {
  const r = cardRect(x, y, w, h, dx, dy);
  return { cx: r.cx, cy: r.cy };
}

function rectsOverlap(a: AABB, b: AABB, pad: number): boolean {
  return (
    a.left < b.right + pad &&
    a.right > b.left - pad &&
    a.top < b.bottom + pad &&
    a.bottom > b.top - pad
  );
}

function rectInside(rect: AABB, bounds: AABB): boolean {
  return (
    rect.left >= bounds.left &&
    rect.right <= bounds.right &&
    rect.top >= bounds.top &&
    rect.bottom <= bounds.bottom
  );
}

/**
 * Stage 2: normalize a screen-space curb direction to a unit vector. Returns
 * null when absent or degenerate (zero-length), so the scorer/pre-pass treat a
 * malformed hint as no hint (Stage-1 fallthrough).
 */
function unitSide(side: { dx: number; dy: number } | undefined): { dx: number; dy: number } | null {
  if (!side) return null;
  const m = Math.hypot(side.dx, side.dy);
  if (m === 0 || !Number.isFinite(m)) return null;
  return { dx: side.dx / m, dy: side.dy / m };
}

function rotate(v: { dx: number; dy: number }, degrees: number): { dx: number; dy: number } {
  const a = degrees * RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { dx: v.dx * cos - v.dy * sin, dy: v.dx * sin + v.dy * cos };
}

function offsetInsideCurbCone(off: Offset, side: { dx: number; dy: number }): boolean {
  const len = Math.hypot(off.dx, off.dy);
  if (len === 0 || !Number.isFinite(len)) return false;
  return (off.dx * side.dx + off.dy * side.dy) / len >= CURB_CONE_MIN_DOT;
}

export function solveLabels(input: SolveInput): SolveResult {
  const { dots, obstacles, viewport, prev, selectedId } = input;
  const hardHide = input.hardHide ?? false;
  const isOnscreen = (d: LabelDot): boolean =>
    d.onscreen ?? (d.x >= 0 && d.x <= viewport.w && d.y >= 0 && d.y <= viewport.h);

  const order = dots.slice().sort((a, b) => {
    if (a.id === selectedId) return -1;
    if (b.id === selectedId) return 1;
    if (isOnscreen(a) !== isOnscreen(b)) return isOnscreen(a) ? -1 : 1;
    if (b.lineCount !== a.lineCount) return b.lineCount - a.lineCount;
    return a.id < b.id ? -1 : 1; // JS string compare — do NOT localeCompare
  });

  const placed: Rect[] = [];
  const offsets = new Map<string, Offset>();
  const hidden = new Set<string>();
  const dotPts = dots.map((d) => ({ id: d.id, x: d.x, y: d.y }));
  const vp = { left: VP_INSET, top: VP_INSET, right: viewport.w - VP_INSET, bottom: viewport.h - VP_INSET };

  for (const d of order) {
    const prevOff = prev.get(d.id) ?? null;
    const sideUnit = unitSide(d.side);
    const dotOnscreen = isOnscreen(d);

    const coversOtherDot = (r: Rect): boolean => {
      for (const pt of dotPts) {
        if (pt.id === d.id) continue;
        if (pt.x > r.left - 5 && pt.x < r.right + 5 && pt.y > r.top - 5 && pt.y < r.bottom + 5) {
          return true;
        }
      }
      return false;
    };

    // Stage 2: within the same global priority order, try a bounded curb cone
    // before the ordinary 360° candidates. This keeps selected/on-screen stops
    // ahead of buffered stops and avoids long exact-ray connectors. A previous
    // Stage-1 offset is reusable only when it already satisfies this cone.
    if (d.pinToSide && sideUnit) {
      const isCleanCurbOffset = (off: Offset): boolean => {
        const r = cardRect(d.x, d.y, d.w, d.h, off.dx, off.dy);
        return (
          offsetInsideCurbCone(off, sideUnit) &&
          !placed.some((q) => rectsOverlap(r, q, PAD)) &&
          !obstacles.some((o) => rectsOverlap(r, o, 0)) &&
          !coversOtherDot(r) &&
          (!dotOnscreen || rectInside(r, vp))
        );
      };

      let curbOffset: Offset | null = null;
      if (
        prevOff &&
        Math.hypot(prevOff.dx, prevOff.dy) <= HYSTERESIS_MAX &&
        isCleanCurbOffset(prevOff)
      ) {
        curbOffset = prevOff;
      } else {
        for (let dist = D_MIN; dist <= D_MAX && !curbOffset; dist += D_STEP) {
          for (const degrees of CURB_CONE_DEGREES) {
            const dir = rotate(sideUnit, degrees);
            const candidate = { dx: dir.dx * dist, dy: dir.dy * dist };
            if (isCleanCurbOffset(candidate)) {
              curbOffset = candidate;
              break;
            }
          }
        }
      }

      if (curbOffset) {
        offsets.set(d.id, curbOffset);
        placed.push(cardRect(d.x, d.y, d.w, d.h, curbOffset.dx, curbOffset.dy));
        continue;
      }
      // No clean bounded curb candidate: fall through to the ordinary scan.
    }

    // Hysteresis short-circuit: reuse prev iff card-overlap-free against placed,
    // obstacle-free, within 60px, and still in-view when its dot is on-screen.
    // Buffered off-screen dots retain the old permissive behavior until entry.
    if (prevOff && (!d.pinToSide || !sideUnit || offsetInsideCurbCone(prevOff, sideUnit))) {
      const prevDist = Math.hypot(prevOff.dx, prevOff.dy);
      if (prevDist <= HYSTERESIS_MAX) {
        const r = cardRect(d.x, d.y, d.w, d.h, prevOff.dx, prevOff.dy);
        const dirty =
          placed.some((q) => rectsOverlap(r, q, PAD)) ||
          obstacles.some((o) => rectsOverlap(r, o, 0)) ||
          (d.pinToSide && coversOtherDot(r)) ||
          (dotOnscreen && !rectInside(r, vp));
        if (!dirty) {
          placed.push(r);
          offsets.set(d.id, prevOff);
          continue;
        }
      }
    }

    let best: Offset | null = null;
    let bestScore = Infinity;
    let bestCC: Offset | null = null; // best card-overlap-free candidate
    let bestCCScore = Infinity;

    for (const [nx, ny] of DIRS) {
      for (let dist = D_MIN; dist <= D_MAX; dist += D_STEP) {
        const dx = nx * dist;
        const dy = ny * dist;
        const r = cardRect(d.x, d.y, d.w, d.h, dx, dy);

        let score = dist * W.dist;
        let clean = true;
        let cardOverlap = false;

        for (const q of placed) {
          if (rectsOverlap(r, q, PAD)) {
            score += W.cardOverlap;
            clean = false;
            cardOverlap = true;
            break;
          }
        }
        if (r.left < vp.left || r.right > vp.right || r.top < vp.top || r.bottom > vp.bottom) {
          score += W.outView;
          clean = false;
        }
        for (const o of obstacles) {
          if (rectsOverlap(r, o, 0)) {
            score += W.obstacle;
            clean = false;
            break;
          }
        }
        for (const pt of dotPts) {
          if (Math.abs(pt.x - d.x) < 1 && Math.abs(pt.y - d.y) < 1) continue; // self-skip by COORD
          if (pt.x > r.left - 5 && pt.x < r.right + 5 && pt.y > r.top - 5 && pt.y < r.bottom + 5) {
            score += W.coverDot;
            clean = false;
            break;
          }
        }
        if (prevOff) {
          score += (Math.abs(dx - prevOff.dx) + Math.abs(dy - prevOff.dy)) * W.stick;
        }
        // Stage 2 road-side bias: penalize candidate directions pointing AWAY
        // from the curb side (dot.side). Gated on sideUnit so the Stage-1 score
        // path is byte-identical when the hint is absent. A candidate aligned
        // with `side` adds 0; the opposite direction adds the full W.road. This
        // is a SOFT term — it does not touch `clean`/`cardOverlap`.
        if (sideUnit) {
          score += W.road * Math.max(0, -(nx * sideUnit.dx + ny * sideUnit.dy));
        }

        if (score < bestScore) {
          bestScore = score;
          best = { dx, dy };
        }
        if (!cardOverlap && score < bestCCScore) {
          bestCCScore = score;
          bestCC = { dx, dy };
        }
        // Greedy early-out — inner dist loop ONLY. Suppressed when a road-side
        // hint is present so the soft bias can steer past the first clean spot;
        // when sideUnit is null this is the exact Stage-1 condition.
        if (clean && !prevOff && !sideUnit) break;
      }
    }

    let chosen: Offset | null;
    if (hardHide) {
      if (bestCC) chosen = bestCC;
      else if (d.id === selectedId) chosen = best;
      else {
        hidden.add(d.id);
        continue;
      }
    } else {
      chosen = best;
    }
    if (!chosen) {
      hidden.add(d.id);
      continue;
    }
    offsets.set(d.id, chosen);
    placed.push(cardRect(d.x, d.y, d.w, d.h, chosen.dx, chosen.dy));
  }

  // Metrics. overlaps tested at pad=0 (true visual overlap), decoupled from PAD.
  let overlaps = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (rectsOverlap(placed[i], placed[j], 0)) overlaps++;
    }
  }
  let shifts = 0;
  for (const [id, off] of offsets) {
    const p = prev.get(id);
    if (p && (p.dx !== off.dx || p.dy !== off.dy)) shifts++;
  }
  let hideFlips = 0;
  for (const id of hidden) {
    if (prev.has(id)) hideFlips++;
  }

  return { offsets, hidden, metrics: { overlaps, shifts, hideFlips } };
}

/**
 * Diff the previously-dimmed id set against the new hidden set.
 * `toClear` is the symmetric leftover — every id that was dimmed but is no
 * longer hidden (became visible OR left the viewport) — so stale dim never
 * leaks.
 */
export function diffDimmed(
  prevDimmed: Set<string>,
  nextHidden: Set<string>,
): { toSet: string[]; toClear: string[] } {
  const toSet: string[] = [];
  for (const id of nextHidden) {
    if (!prevDimmed.has(id)) toSet.push(id);
  }
  const toClear: string[] = [];
  for (const id of prevDimmed) {
    if (!nextHidden.has(id)) toClear.push(id);
  }
  return { toSet, toClear };
}
