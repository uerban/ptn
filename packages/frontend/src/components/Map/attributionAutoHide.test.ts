import { describe, test, expect, afterEach } from "vitest";
import type * as maplibregl from "maplibre-gl";
import {
  ATTRIBUTION_SEEN_STORAGE_KEY,
  installAttributionAutoHide,
} from "./attributionAutoHide.ts";

type Handler = () => void;

function fakeMap() {
  const container = document.createElement("div");
  const attrib = document.createElement("details");
  attrib.className = "maplibregl-ctrl-attrib";
  container.appendChild(attrib);
  document.body.appendChild(container);
  const handlers = new Map<string, Set<Handler>>();
  const on = (type: string, fn: Handler) => {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type)!.add(fn);
  };
  const off = (type: string, fn: Handler) => {
    handlers.get(type)?.delete(fn);
  };
  const map = {
    on,
    off,
    once: (type: string, fn: Handler) => {
      const wrapped = () => {
        off(type, wrapped);
        fn();
      };
      on(type, wrapped);
    },
    getContainer: () => container,
  };
  const fire = (type: string) => {
    for (const fn of [...(handlers.get(type) ?? [])]) fn();
  };
  // What MapLibre's AttributionControl does on the first data with text.
  const expand = () => {
    attrib.classList.add("maplibregl-compact", "maplibregl-compact-show");
    fire("sourcedata");
  };
  return {
    map: map as unknown as Pick<maplibregl.Map, "on" | "off" | "once" | "getContainer">,
    attrib,
    fire,
    expand,
    listenerCount: (type: string) => handlers.get(type)?.size ?? 0,
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe("installAttributionAutoHide", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const tap = (el: Element) =>
    el.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));

  test("first launch: stays expanded until the first interaction, then remembers it", () => {
    const m = fakeMap();
    const storage = memoryStorage();
    installAttributionAutoHide(m.map, storage);

    m.fire("styledata"); // no text yet → nothing expanded
    m.expand();
    expect(m.attrib.classList.contains("maplibregl-compact-show")).toBe(true);
    expect(storage.data.has(ATTRIBUTION_SEEN_STORAGE_KEY)).toBe(false);

    // A stop label / chip: a DOM overlay outside the map container.
    const chip = document.createElement("button");
    document.body.appendChild(chip);
    tap(chip);
    expect(m.attrib.classList.contains("maplibregl-compact-show")).toBe(false);
    expect(storage.data.get(ATTRIBUTION_SEEN_STORAGE_KEY)).toBe("1");
  });

  test("taps on the attribution itself don't count", () => {
    const m = fakeMap();
    const storage = memoryStorage();
    installAttributionAutoHide(m.map, storage);
    m.expand();
    tap(m.attrib);
    expect(m.attrib.classList.contains("maplibregl-compact-show")).toBe(true);
    expect(storage.data.has(ATTRIBUTION_SEEN_STORAGE_KEY)).toBe(false);
  });

  test("a key press counts as an interaction", () => {
    const m = fakeMap();
    installAttributionAutoHide(m.map, memoryStorage());
    m.expand();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(m.attrib.classList.contains("maplibregl-compact-show")).toBe(false);
  });

  test("stops listening after the first collapse", () => {
    const m = fakeMap();
    installAttributionAutoHide(m.map, memoryStorage());
    m.expand();
    tap(document.body);
    m.attrib.classList.add("maplibregl-compact-show"); // rider opens (i)
    tap(document.body);
    expect(m.attrib.classList.contains("maplibregl-compact-show")).toBe(true);
  });

  test("later launch: collapses immediately", () => {
    const m = fakeMap();
    installAttributionAutoHide(m.map, memoryStorage({ [ATTRIBUTION_SEEN_STORAGE_KEY]: "1" }));
    m.expand();
    expect(m.attrib.classList.contains("maplibregl-compact-show")).toBe(false);
  });

  test("leaves the rider's own toggles alone after the first collapse", () => {
    const m = fakeMap();
    installAttributionAutoHide(m.map, memoryStorage({ [ATTRIBUTION_SEEN_STORAGE_KEY]: "1" }));
    m.expand();
    expect(m.listenerCount("styledata")).toBe(0);
    expect(m.listenerCount("sourcedata")).toBe(0);
    expect(m.listenerCount("resize")).toBe(0);

    m.attrib.classList.add("maplibregl-compact-show"); // rider taps (i)
    m.fire("sourcedata");
    m.fire("styledata");
    expect(m.attrib.classList.contains("maplibregl-compact-show")).toBe(true);
  });

  test("wide map: full text untouched until a resize turns it compact", () => {
    const m = fakeMap();
    installAttributionAutoHide(m.map, memoryStorage({ [ATTRIBUTION_SEEN_STORAGE_KEY]: "1" }));
    m.fire("sourcedata"); // wide: MapLibre renders inline text, no compact classes
    expect(m.listenerCount("sourcedata")).toBe(1);

    m.attrib.classList.add("maplibregl-compact", "maplibregl-compact-show");
    m.fire("resize");
    expect(m.attrib.classList.contains("maplibregl-compact-show")).toBe(false);
  });

  test("map removal stops watching", () => {
    const m = fakeMap();
    const storage = memoryStorage();
    installAttributionAutoHide(m.map, storage);
    m.expand();
    m.fire("remove");
    tap(document.body);
    expect(storage.data.has(ATTRIBUTION_SEEN_STORAGE_KEY)).toBe(false);
  });

  test("storage that throws does not break the map", () => {
    const m = fakeMap();
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    installAttributionAutoHide(m.map, throwing);
    m.expand();
    expect(() => tap(document.body)).not.toThrow();
    expect(m.attrib.classList.contains("maplibregl-compact-show")).toBe(false);
  });
});
