import { expect, test } from "@playwright/test";
import { mockApiAtServiceTime } from "../helpers/mock-api";

// Mount a controlled real TransitMap over the fixture app. This isolates the
// presentation contract from timetable timing while exercising MapLibre and
// the actual HTML-marker/feature-state integration.
test("urban stop exit fades card and dot together without accepting clicks @mock-api", async ({ page }) => {
  const vite = await page.request.get("/@vite/client");
  test.skip(!vite.ok() || !(await vite.text()).includes("vite"), "Controlled component harness requires the Vite development server");
  await mockApiAtServiceTime(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__ptnMap);
  await page.evaluate(async () => {
    const module = "/src/stores/gtfsDataStore.ts";
    const { useGtfsDataStore } = await import(module);
    await new Promise<void>((resolve) => {
      if (useGtfsDataStore.getState().raptorIndex && !useGtfsDataStore.getState().syncing) { resolve(); return; }
      const unsubscribe = useGtfsDataStore.subscribe((state: any) => {
        if (state.raptorIndex && !state.syncing) { unsubscribe(); resolve(); }
      });
    });
    const reactPath = "/node_modules/.vite/deps/react.js";
    const domPath = "/node_modules/.vite/deps/react-dom_client.js";
    const flushPath = "/node_modules/.vite/deps/react-dom.js";
    const cityPath = "/src/stores/cityStore.ts";
    const {useCityStore} = await import(cityPath);
    const mapPath = "/src/components/Map/TransitMap.tsx";
    const reactModule = await import(reactPath);
    const React = reactModule.default ?? reactModule;
    const domModule = await import(domPath);
    const flushModule = await import(flushPath);
    const flushSync = flushModule.flushSync ?? flushModule.default.flushSync;
    const createRoot = domModule.createRoot ?? domModule.default.createRoot;
    const { TransitMap } = await import(mapPath);
    const host = document.createElement("div");
    host.dataset.fadeHarness = "true";
    host.style.cssText = "position:fixed;inset:0;z-index:99999;background:white";
    document.body.append(host);
    const root = createRoot(host);
    const stop = { id: "fade-stop", name: "Fade stop", location: { lat: 54.6872, lon: 25.2797 }, lines: [], lastSeen: 0 };
    const harness = (window as any).__fadeHarness = { clicks: 0, map: null, render: null, stop, replaceCity: null, refresh: () => useGtfsDataStore.getState().refresh("vilnius") };
    const geometryStops = [stop];
    harness.render = (active: boolean, lines: any[] = []) => flushSync(() => root.render(React.createElement(TransitMap, {
      stops: active ? [{...stop, lines}] : [], geometryStops, center: stop.location, zoom: 17,
      onStopClick: () => { harness.clicks++; }, onMapReady: (map: any) => { harness.map = map; },
    })));
    harness.replaceCity = () => flushSync(() => useCityStore.getState().setActiveCity({
      ...useCityStore.getState().activeCity, id: "krakow", name: "Krakow", center: {lat: 50.0647, lon: 19.945},
    }));
    harness.render(true);
  });
  const marker = page.locator('[data-fade-harness] [data-stop-id="fade-stop"]');
  await expect(marker).toBeAttached();
  await page.waitForFunction(() => (window as any).__fadeHarness.map?.getSource("stops-source"));
  const badgeUpdate = await page.evaluate(async () => {
    const h = (window as any).__fadeHarness;
    const source = h.map.getSource("stops-source");
    const nativeSetData = source.setData.bind(source);
    let writes = 0;
    source.setData = (...args: any[]) => { writes++; return nativeSetData(...args); };
    h.render(true, [{routeId: "badge-route", shortName: "B", mode: "BUS"}]);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    source.setData = nativeSetData;
    return {writes, text: document.querySelector('[data-fade-harness] [data-stop-id="fade-stop"]')?.textContent};
  });
  expect(badgeUpdate.text).toContain("B");
  expect(badgeUpdate.writes).toBe(0);
  const result = await page.evaluate(async () => {
    const h = (window as any).__fadeHarness;
    h.render(false);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const el = document.querySelector<HTMLElement>('[data-fade-harness] [data-stop-id="fade-stop"]')!;
    const inert = el.inert;
    el.querySelector<HTMLElement>(".cursor-pointer")?.click();
    // An unchanged background refresh must not cancel this exit.
    void h.refresh();
    h.map.jumpTo({ bearing: 1 });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return { inert, clicks: h.clicks, opacity: Number(el.style.opacity),
      dotOpacity: h.map.getFeatureState({ source: "stops-source", id: "fade-stop" }).exitOpacity };
  });
  expect(result.inert).toBe(true);
  expect(result.clicks).toBe(0);
  expect(result.opacity).toBeGreaterThan(0);
  expect(result.opacity).toBeLessThan(1);
  expect(result.dotOpacity).toBeCloseTo(result.opacity);
  await expect(marker).toHaveCount(0);

  await page.evaluate(() => (window as any).__fadeHarness.render(true));
  await expect(marker).toBeAttached();
  await expect(marker).toHaveCSS("opacity", "1");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => (window as any).__fadeHarness.render(false));
  await expect(marker).toHaveCount(0);

  await page.emulateMedia({reducedMotion: "no-preference"});
  const restore = async () => {
    await page.evaluate(() => {
      const h = (window as any).__fadeHarness;
      h.map.jumpTo({center: [h.stop.location.lon, h.stop.location.lat], bearing: 0, zoom: 17});
      h.render(true);
    });
    await expect(marker).toBeAttached();
  };

  // Reactivate while an exit is still running; preserve the DOM marker and
  // cancel its old retirement rather than remounting after 200 ms.
  await restore();
  const reactivated = await page.evaluate(async () => {
    const h = (window as any).__fadeHarness;
    const original = document.querySelector('[data-fade-harness] [data-stop-id="fade-stop"]');
    h.render(false);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    h.render(true, [{routeId: "reactivated", shortName: "R", mode: "BUS"}]);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const current = document.querySelector<HTMLElement>('[data-fade-harness] [data-stop-id="fade-stop"]')!;
    return {same: current === original, inert: current.inert, opacity: Number(current.style.opacity), text: current.textContent};
  });
  expect(reactivated).toMatchObject({same: true, inert: false, opacity: 1});
  expect(reactivated.text).toContain("R");
  await page.waitForTimeout(250);
  await expect(marker).toHaveCount(1);

  // The dot can be wholly outside while its existing card still intersects
  // the viewport. That visible card must fade rather than vanish immediately.
  await restore();
  const edge = await page.evaluate(async () => {
    const h = (window as any).__fadeHarness;
    const map = h.map, canvas = map.getCanvas();
    const card = document.querySelector<HTMLElement>('[data-fade-harness] [data-stop-id="fade-stop"] .cursor-pointer')!;
    const rect = card.getBoundingClientRect(), viewport = canvas.getBoundingClientRect();
    const point = map.project([h.stop.location.lon, h.stop.location.lat]);
    const bottom = rect.bottom - viewport.top - point.y;
    const top = rect.top - viewport.top - point.y;
    const targetY = bottom >= 24 ? -Math.max(12, bottom / 2) : canvas.clientHeight + Math.max(12, -top / 2);
    const center = map.unproject([canvas.clientWidth / 2, canvas.clientHeight / 2 + point.y - targetY]);
    map.jumpTo({center});
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const actual = map.project([h.stop.location.lon, h.stop.location.lat]);
    const currentRect = card.getBoundingClientRect();
    const intersects = currentRect.right > viewport.left && currentRect.left < viewport.right && currentRect.bottom > viewport.top && currentRect.top < viewport.bottom;
    h.render(false);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const el = document.querySelector<HTMLElement>('[data-fade-harness] [data-stop-id="fade-stop"]');
    return {dotOutside: actual.y < -9 || actual.y > canvas.clientHeight + 9, intersects,
      attached: !!el, inert: el?.inert, opacity: el ? Number(el.style.opacity) : 0};
  });
  expect(edge.dotOutside).toBe(true);
  expect(edge.intersects).toBe(true);
  expect(edge.attached).toBe(true);
  expect(edge.inert).toBe(true);
  expect(edge.opacity).toBeGreaterThan(0);
  expect(edge.opacity).toBeLessThan(1);
  await expect(marker).toHaveCount(0);

  // A rendered symbol label also counts when both its dot and HTML card
  // are outside/absent. Exercise the actual MapLibre collision/query result.
  await restore();
  await page.evaluate(() => {
    const h = (window as any).__fadeHarness;
    h.map.jumpTo({zoom: 14.5});
  });
  await expect(marker).toHaveCount(0);
  await page.waitForFunction(() => {
    const map = (window as any).__fadeHarness.map;
    return map.getLayer("stops-label") && map.queryRenderedFeatures(undefined, {layers: ["stops-label"]})
      .some((feature: any) => feature.properties.id === "fade-stop");
  });
  const labelEdge = await page.evaluate(async () => {
    const h = (window as any).__fadeHarness, map = h.map, canvas = map.getCanvas();
    const point = map.project([h.stop.location.lon, h.stop.location.lat]);
    map.jumpTo({center: map.unproject([canvas.clientWidth / 2, canvas.clientHeight / 2 + point.y + 12])});
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const visible = (layer: string) => map.queryRenderedFeatures([[0, 0], [canvas.clientWidth, canvas.clientHeight]], {layers: [layer]})
      .some((feature: any) => feature.properties.id === "fade-stop");
    const labelVisible = visible("stops-label"), dotVisible = visible("stops-dot");
    h.render(false);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return {labelVisible, dotVisible, opacity: map.getFeatureState({source: "stops-source", id: "fade-stop"}).exitOpacity};
  });
  expect(labelEdge.labelVisible).toBe(true);
  expect(labelEdge.dotVisible).toBe(false);
  expect(labelEdge.opacity).toBeGreaterThan(0);
  expect(labelEdge.opacity).toBeLessThan(1);
  await page.waitForFunction(() => !(window as any).__fadeHarness.map.queryRenderedFeatures(undefined, {layers: ["stops-label"]})
    .some((feature: any) => feature.properties.id === "fade-stop"));

  await restore();
  const offscreenCount = await page.evaluate(async () => {
    const h = (window as any).__fadeHarness;
    h.map.panBy([h.map.getCanvas().clientWidth * .75, 0], {duration: 0});
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    h.render(false);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return document.querySelectorAll('[data-fade-harness] [data-stop-id="fade-stop"]').length;
  });
  expect(offscreenCount).toBe(0);

  await restore();
  const panExitCount = await page.evaluate(async () => {
    const h = (window as any).__fadeHarness;
    h.render(false);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    h.map.panBy([h.map.getCanvas().clientWidth * .75, 0], {duration: 0});
    for (let i = 0; i < 3; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    h.map.jumpTo({center: [h.stop.location.lon, h.stop.location.lat]});
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return document.querySelectorAll('[data-fade-harness] [data-stop-id="fade-stop"]').length;
  });
  expect(panExitCount).toBe(0);

  await restore();
  await page.evaluate(async () => {
    const h = (window as any).__fadeHarness;
    h.render(false);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    h.replaceCity();
  });
  await expect(marker).toHaveCount(0);

});
