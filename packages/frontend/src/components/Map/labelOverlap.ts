import type { LabelAnchor } from "@pt/shared";

// ── Phase 3: screen-space label overlap resolver ─────────────────────────────
//
// The backend solver (`packages/backend/src/gtfs/labelAnchors.ts`) assigns each
// stop a label anchor in GEO space, zoom-independent. At a given zoom two anchored
// labels can still collide on screen (or a label can cover another stop's dot).
// This pass runs in pixel space over the currently-visible labels and
// rotates colliding ones to a
// lower-cost direction, so both stay visible instead of one being culled by
// MapLibre's symbol collision.
//
// Pure and deterministic: it takes projected positions + measured text widths +
// the solver's anchors, and returns a refined anchor per item (same order). It is
// additive — MapLibre's own collision stays on as a backstop.

/** Anchor order — index basis shared with the solver's `DIRS`. */
const ANCHORS: readonly LabelAnchor[] = [
  "right",
  "top-right",
  "top",
  "top-left",
  "left",
  "bottom-left",
  "bottom",
  "bottom-right",
];

// Label-box geometry, mirroring the prototype (`FS`, `L_OFF`, `PX`, `PY`).
const FONT_SIZE = 11;
const PAD_X = 3;
const PAD_Y = 2;
const OFFSET = 10; // straight-direction gap from the dot (px)
const DIAG = OFFSET * 0.75; // diagonal gap per axis (px)
const DOT_RADIUS = 4;
const DOT_MARGIN = 2;
/** Extra cost multiplier for covering another stop's dot vs. another label. */
const DOT_PENALTY = 5;
/** Penalty per direction-step away from the solver's chosen anchor. */
const ROTATE_PENALTY = 2;
const MAX_PASSES = 4;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bounding box of a label placed on `anchor` side of the dot at `(x, y)`.
 * Port of the prototype's `lbox`.
 */
export function labelBox(
  x: number,
  y: number,
  textWidth: number,
  anchor: LabelAnchor,
): Box {
  const w = textWidth + PAD_X * 2;
  const h = FONT_SIZE + PAD_Y * 2;
  let lx: number;
  let ly: number;
  switch (anchor) {
    case "right":
      lx = x + OFFSET;
      ly = y - h / 2;
      break;
    case "left":
      lx = x - OFFSET - w;
      ly = y - h / 2;
      break;
    case "top":
      lx = x - w / 2;
      ly = y - OFFSET - h;
      break;
    case "bottom":
      lx = x - w / 2;
      ly = y + OFFSET;
      break;
    case "top-right":
      lx = x + DIAG;
      ly = y - DIAG - h;
      break;
    case "top-left":
      lx = x - DIAG - w;
      ly = y - DIAG - h;
      break;
    case "bottom-right":
      lx = x + DIAG;
      ly = y + DIAG;
      break;
    case "bottom-left":
      lx = x - DIAG - w;
      ly = y + DIAG;
      break;
  }
  return { x: lx, y: ly, w, h };
}

function dotBox(x: number, y: number): Box {
  const r = DOT_RADIUS + DOT_MARGIN;
  return { x: x - r, y: y - r, w: r * 2, h: r * 2 };
}

function rectsOverlap(a: Box, b: Box): boolean {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

/** Area of the intersection of two boxes (0 when disjoint). */
export function overlapArea(a: Box, b: Box): number {
  if (!rectsOverlap(a, b)) return 0;
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w * h;
}

export interface LabelItem {
  x: number;
  y: number;
  width: number;
  anchor: LabelAnchor;
}

/**
 * Refine each label's anchor to reduce on-screen overlaps. Returns a new anchor
 * per item, in input order. Items unaffected by collisions keep their solver
 * anchor. Port of the prototype's `resolveOverlaps`.
 */
export function resolveLabelOverlaps(items: readonly LabelItem[]): LabelAnchor[] {
  const dirs = items.map((it) => it.anchor);
  const boxes = items.map((it, i) => labelBox(it.x, it.y, it.width, dirs[i]));
  const dots = items.map((it) => dotBox(it.x, it.y));

  const cost = (box: Box, self: number): number => {
    let c = 0;
    for (let j = 0; j < boxes.length; j++) {
      if (j !== self) c += overlapArea(box, boxes[j]);
    }
    for (let j = 0; j < dots.length; j++) {
      if (j !== self) c += overlapArea(box, dots[j]) * DOT_PENALTY;
    }
    return c;
  };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (let i = 0; i < boxes.length; i++) {
      const current = cost(boxes[i], i);
      if (current === 0) continue;

      const curIdx = ANCHORS.indexOf(dirs[i]);
      let bestDir = dirs[i];
      let bestCost = current;
      for (let d = 1; d < 8; d++) {
        const tryDir = ANCHORS[(curIdx + d) % 8];
        const tryBox = labelBox(items[i].x, items[i].y, items[i].width, tryDir);
        const c = cost(tryBox, i) + d * ROTATE_PENALTY;
        if (c < bestCost) {
          bestCost = c;
          bestDir = tryDir;
        }
      }
      if (bestDir !== dirs[i]) {
        dirs[i] = bestDir;
        boxes[i] = labelBox(items[i].x, items[i].y, items[i].width, bestDir);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return dirs;
}
