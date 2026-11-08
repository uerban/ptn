interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Fit a leg into the map above the navigation panel, in window coordinates. */
export function guidancePadding(map: Rect, panel: Rect | undefined, margin: number) {
  const overlaps = panel && panel.right > map.left && panel.left < map.right
    && panel.bottom >= map.bottom && panel.top < map.bottom;
  const covered = overlaps ? map.bottom - Math.max(map.top, panel.top) : 0;
  // Leave a nonzero fitting area even when the panel fills the map.
  const bottom = Math.min(covered + margin, Math.max(margin, map.bottom - map.top - margin - 1));
  return { top: margin, right: margin, bottom, left: margin };
}
