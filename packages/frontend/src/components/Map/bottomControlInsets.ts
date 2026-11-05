import type * as maplibregl from "maplibre-gl";

/** CSS custom properties the bottom chip strip (`ETACards`) positions itself by. */
export const CHIPS_BOTTOM_VAR = "--map-chips-bottom";
export const CHIPS_RIGHT_VAR = "--map-chips-right";

/** Gap kept between the chips and the controls / map edge, in px. */
const GAP = 8;

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface ChipInsets {
  /** Distance of the strip's bottom edge from the map's bottom edge. */
  bottom: number;
  /** Space the strip must leave free on the right. */
  right: number;
}

/**
 * Where the bottom chip strip may sit next to MapLibre's bottom-right
 * controls (zoom, geolocate, attribution).
 *
 * The strip shares the attribution's baseline, so the chips sit at the bottom
 * edge instead of floating above the (i) button, and leaves the whole control
 * column free on the right so nothing overlaps. While the compact attribution
 * is expanded its text spans most of the map width, so the strip lifts above
 * it instead and only clears the controls stacked over it.
 */
export function chipInsets(
  map: Box,
  attrib: Box | null,
  controls: readonly Box[],
  attribExpanded: boolean,
): ChipInsets {
  const clearOf = (boxes: readonly Box[]) =>
    boxes.reduce((max, b) => Math.max(max, map.right - b.left + GAP), 0);
  if (!attrib) return { bottom: GAP, right: clearOf(controls) };
  if (attribExpanded) {
    return { bottom: map.bottom - attrib.top + GAP, right: clearOf(controls) };
  }
  return {
    bottom: Math.max(GAP, map.bottom - attrib.bottom),
    right: clearOf([...controls, attrib]),
  };
}

/**
 * Keeps `CHIPS_BOTTOM_VAR` / `CHIPS_RIGHT_VAR` on `target` in step with the
 * map's bottom-right controls as they resize (attribution expand/collapse,
 * compact switch, the departure sheet pushing the controls up). Removes the
 * variables when the map is removed, so the strip falls back to its defaults.
 */
export function trackBottomControlInsets(
  map: Pick<maplibregl.Map, "getContainer" | "once">,
  target: HTMLElement = document.documentElement,
): void {
  if (typeof ResizeObserver === "undefined") return;
  const container = map.getContainer();
  const corner = container.querySelector<HTMLElement>(".maplibregl-ctrl-bottom-right");
  if (!corner) return;

  const update = () => {
    const attrib = corner.querySelector<HTMLElement>(".maplibregl-ctrl-attrib");
    const controls = [...corner.children].filter((el) => el !== attrib);
    const insets = chipInsets(
      container.getBoundingClientRect(),
      attrib ? attrib.getBoundingClientRect() : null,
      controls.map((el) => el.getBoundingClientRect()),
      !!attrib?.classList.contains("maplibregl-compact-show"),
    );
    target.style.setProperty(CHIPS_BOTTOM_VAR, `${insets.bottom}px`);
    target.style.setProperty(CHIPS_RIGHT_VAR, `${insets.right}px`);
  };

  const resize = new ResizeObserver(update);
  resize.observe(container);
  resize.observe(corner, { box: "border-box" });
  // The attribution's text arrives after the control mounts; observe each
  // child as it appears (expanding it also changes its size).
  const observeChildren = () => {
    for (const el of corner.children) resize.observe(el);
  };
  observeChildren();
  const mutations = new MutationObserver(() => {
    observeChildren();
    update();
  });
  // `style` too: the sheet lift (`sheetControlLift`) moves the controls by
  // padding, which changes no observed content box.
  mutations.observe(corner, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  update();

  map.once("remove", () => {
    resize.disconnect();
    mutations.disconnect();
    target.style.removeProperty(CHIPS_BOTTOM_VAR);
    target.style.removeProperty(CHIPS_RIGHT_VAR);
  });
}
