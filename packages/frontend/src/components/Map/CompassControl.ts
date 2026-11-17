import type maplibregl from "../../map/maplibre.ts";

type Translate = (key: string, fallback?: string) => string;

/** Bearings this close to north count as north (float noise after easing). */
const NORTH_EPSILON_DEG = 0.5;

function needleIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "ptn-compass-needle");
  const north = document.createElementNS(ns, "path");
  north.setAttribute("d", "M12 2 L16 12 L8 12 Z");
  north.setAttribute("class", "ptn-compass-north");
  const south = document.createElementNS(ns, "path");
  south.setAttribute("d", "M12 22 L8 12 L16 12 Z");
  south.setAttribute("class", "ptn-compass-south");
  svg.append(north, south);
  return svg;
}

/**
 * Shows which way north is while the map is rotated or tilted; a tap turns it
 * back to north and flat. Hidden at north, so it costs no room until needed.
 */
export class CompassControl implements maplibregl.IControl {
  private map: maplibregl.Map | null = null;
  private container = document.createElement("div");
  private button = document.createElement("button");
  private needle = needleIcon();

  constructor(private t: Translate) {
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-group ptn-compass-group";
    this.button.type = "button";
    this.button.className = "ptn-compass";
    this.button.dataset.testid = "map-compass";
    this.button.appendChild(this.needle);
    this.button.addEventListener("click", () => {
      this.map?.easeTo({ bearing: 0, pitch: 0 });
    });
    this.button.addEventListener("blur", () => this.update());
    this.container.appendChild(this.button);
  }

  onAdd(map: maplibregl.Map) {
    this.map = map;
    map.on("rotate", this.update);
    map.on("pitch", this.update);
    this.update();
    return this.container;
  }

  onRemove() {
    this.map?.off("rotate", this.update);
    this.map?.off("pitch", this.update);
    this.container.remove();
    this.map = null;
  }

  update = () => {
    if (!this.map) return;
    const bearing = this.map.getBearing();
    const atNorth = Math.abs(bearing) < NORTH_EPSILON_DEG && this.map.getPitch() < NORTH_EPSILON_DEG;
    // Hidden from everyone at north; a focused button keeps focus until moved.
    this.container.hidden = atNorth && document.activeElement !== this.button;
    this.needle.style.transform = `rotate(${-bearing}deg)`;
    const label = this.t("map.compass_reset", "Turn map to north");
    this.button.title = label;
    this.button.setAttribute("aria-label", label);
  };
}
