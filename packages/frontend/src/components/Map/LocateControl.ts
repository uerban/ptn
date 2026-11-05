import maplibregl from "../../map/maplibre.ts";
import { liveLocation } from "../../services/liveLocation.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import type { LatLon } from "@pt/shared";

type Translate = (key: string, fallback?: string) => string;

// Satellite glyph: SVG Repo #1542, CC0 (https://www.svgrepo.com/svg/1542/satellite).
const SATELLITE_PATHS = [
  "M201.359,137.3l-43.831-43.831l11.453-11.452c1.407-1.407,2.197-3.314,2.197-5.304c0-1.989-0.79-3.896-2.197-5.304l-36.835-36.834c-2.929-2.928-7.677-2.928-10.606,0l-11.452,11.452L66.253,2.196c-2.93-2.928-7.678-2.928-10.606,0L18.813,39.03c-2.929,2.93-2.929,7.678,0,10.607l43.831,43.831l-11.453,11.452c-1.407,1.407-2.197,3.314-2.197,5.304s0.79,3.896,2.197,5.304l36.837,36.836c1.464,1.464,3.384,2.196,5.303,2.196c1.919,0,3.839-0.732,5.303-2.196l11.453-11.453l43.83,43.83c1.465,1.464,3.384,2.196,5.303,2.196c1.919,0,3.839-0.732,5.303-2.196l36.835-36.834c1.407-1.407,2.197-3.314,2.197-5.304C203.556,140.614,202.766,138.707,201.359,137.3z M34.723,44.334L60.95,18.107l38.53,38.526L82.314,73.799l-9.063,9.063L34.723,44.334z M93.331,136.454l-26.23-26.229l11.448-11.447c0.002-0.002,0.003-0.003,0.005-0.005l12.443-12.443l35.845-35.844l26.229,26.228l-11.446,11.446c-0.003,0.003-0.005,0.005-0.007,0.007l-18.417,18.418L93.331,136.454z M159.221,168.831l-38.527-38.526l26.229-26.229l38.527,38.527L159.221,168.831z",
  "M72.344,188.555c-15.317,0.001-29.717-5.964-40.548-16.795C20.965,160.929,15,146.528,15,131.211c0-4.143-3.358-7.5-7.5-7.5c-4.143,0-7.5,3.358-7.5,7.5c0,19.324,7.526,37.491,21.189,51.155c13.663,13.664,31.829,21.189,51.152,21.189c0.001,0,0.002,0,0.004,0c4.142,0,7.499-3.358,7.499-7.5C79.845,191.912,76.486,188.555,72.344,188.555z",
  "M69.346,174.133c4.142,0,7.5-3.357,7.5-7.5c0-4.143-3.358-7.5-7.5-7.5c-6.658,0-12.916-2.593-17.624-7.3c-4.707-4.707-7.299-10.965-7.299-17.622c0-4.142-3.357-7.5-7.5-7.5h0c-4.142,0-7.5,3.358-7.5,7.5c-0.001,10.663,4.152,20.688,11.693,28.229C48.656,169.981,58.682,174.133,69.346,174.133z",
];

function satelliteIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 203.556 203.556");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  for (const d of SATELLITE_PATHS) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  // Slash shown only while paused (CSS), so the state never relies on colour alone.
  const slash = document.createElementNS(ns, "line");
  slash.setAttribute("class", "gps-pause-slash");
  slash.setAttribute("x1", "16"); slash.setAttribute("y1", "16");
  slash.setAttribute("x2", "188"); slash.setAttribute("y2", "188");
  slash.setAttribute("stroke", "currentColor");
  slash.setAttribute("stroke-width", "18");
  slash.setAttribute("stroke-linecap", "round");
  svg.appendChild(slash);
  return svg;
}

/** Recenter is a camera action, independent of the shared foreground watch. */
export class LocateControl implements maplibregl.IControl {
  private map: maplibregl.Map | null = null;
  private container = document.createElement("div");
  private button = document.createElement("button");
  private pauseButton = document.createElement("button");
  private unsubscribe?: () => void;
  private settingsCleanup?: () => void;
  private pending = false;
  private loaded = false;

  constructor(private t: Translate, private onLocation?: (position: LatLon) => void) {
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this.button.className = "maplibregl-ctrl-geolocate";
    this.button.type = "button";
    const icon = document.createElement("span");
    icon.className = "maplibregl-ctrl-icon";
    icon.setAttribute("aria-hidden", "true");
    this.button.appendChild(icon);
    this.container.appendChild(this.button);
    this.button.addEventListener("click", () => this.trigger());
    // Quick battery saver: stops GPS updates without leaving the map.
    this.pauseButton.type = "button";
    this.pauseButton.className = "ptn-gps-pause";
    this.pauseButton.dataset.testid = "gps-pause-toggle";
    this.pauseButton.appendChild(satelliteIcon());
    this.pauseButton.addEventListener("click", () => {
      if (liveLocation.getSnapshot().paused) liveLocation.resume();
      else liveLocation.pause();
    });
    this.container.appendChild(this.pauseButton);
  }

  onAdd(map: maplibregl.Map) {
    this.map = map;
    this.loaded = map.loaded();
    map.on("load", this.onLoad);
    this.unsubscribe = liveLocation.subscribe(this.update);
    this.settingsCleanup = useSettingsStore.subscribe(this.update);
    this.update();
    return this.container;
  }

  onRemove() {
    this.map?.off("load", this.onLoad);
    this.unsubscribe?.();
    this.settingsCleanup?.();
    this.container.remove();
    this.map = null;
  }

  private onLoad = () => {
    this.loaded = true;
    this.update();
  };

  trigger(source: "locate" | "startup" = "locate") {
    this.pending = true;
    if (!liveLocation.request(source)) this.pending = false;
    this.update();
  }

  private update = () => {
    const disabled = useSettingsStore.getState().gpsMode === "disabled";
    const state = liveLocation.getSnapshot();
    if (useSettingsStore.getState().gpsMode !== "enabled" || state.error) this.pending = false;
    this.button.disabled = disabled;
    const label = disabled
      ? this.t("gps.disabled_button", "GPS is off. Enable it in Settings.")
      : this.t("gps.locate", "Locate me");
    this.button.title = label;
    this.button.setAttribute("aria-label", label);
    this.button.setAttribute("aria-busy", String(this.pending && state.loading));
    this.button.classList.toggle("maplibregl-ctrl-geolocate-waiting", this.pending && state.loading);
    const mode = useSettingsStore.getState().gpsMode;
    this.pauseButton.hidden = mode !== "enabled";
    const pauseLabel = state.paused
      ? this.t("gps.resume", "GPS paused. Tap to resume.")
      : this.t("gps.pause", "Pause GPS to save battery");
    this.pauseButton.title = pauseLabel;
    this.pauseButton.setAttribute("aria-label", pauseLabel);
    this.pauseButton.setAttribute("aria-pressed", String(state.paused));
    if (!this.pending || !this.loaded || !this.map || !state.position ||
        state.timestamp === null || Date.now() - state.timestamp > 30_000) return;
    this.pending = false;
    const { lat, lon } = state.position;
    this.map.fitBounds(maplibregl.LngLatBounds.fromLngLat(new maplibregl.LngLat(lon, lat), state.accuracy ?? 0), {
      maxZoom: 15, bearing: this.map.getBearing(),
    }, { geolocateSource: true });
    this.onLocation?.(state.position);
  };
}
