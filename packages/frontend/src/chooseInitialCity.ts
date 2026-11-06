import type {CityConfig} from "./config/cities.ts";
import worldLand from "./map/world-land.json";
import {cityOverviewFeatures} from "./components/Map/cityOverview.ts";

export function restoredCityId(cities: readonly CityConfig[]): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem("ptn-city") ?? "null");
    const id = saved?.state?.activeCity?.id;
    return cities.some(city => city.id === id) ? id : null;
  } catch { return null; }
}

/** An initial city is an explicit user choice, not a backend/default ordering. */
export async function chooseInitialCity(cities: readonly CityConfig[], hostUnavailable = false): Promise<void> {
  // Catalog metadata and downloaded timetable packages are separate states.
  const {listDeviceCities, hasLiveDeviceCity} = await import("./services/deviceCities.ts");
  const {ensureDbReady} = await import("./db/migrationRunner.ts");
  await ensureDbReady();
  const {ensureDataSchemaUpToDate} = await import("./db/dataSchemaVersion.ts");
  await ensureDataSchemaUpToDate();
  const downloaded = new Set((await listDeviceCities()).map(city => city.cityId));
  const installed = new Set(downloaded);
  for (const city of cities) if (await hasLiveDeviceCity(city.id)) installed.add(city.id);
  const offline = hostUnavailable || navigator.onLine === false;
  const saved = restoredCityId(cities);
  if (saved && (!offline || installed.has(saved))) {
    const {useCityStore} = await import("./stores/cityStore.ts");
    useCityStore.getState().setActiveCity(cities.find(city => city.id === saved)!);
    return;
  }
  const root = document.getElementById("root")!;
  root.innerHTML = '<section style="height:100dvh;position:relative;background:#eaf2f7"><div id="city-world-map" style="position:absolute;inset:0" aria-label="World map of served cities"></div><div style="position:absolute;z-index:2;top:16px;left:16px;right:16px;max-width:440px;padding:20px;border-radius:16px;background:var(--surface-raised,#fff);box-shadow:0 4px 24px #0002"><h1 style="font-size:24px;font-weight:600;margin-bottom:8px">Choose a city</h1><p style="font-size:14px;margin-bottom:12px">Choose on the map, or use your location to find coverage nearby.</p><button id="locate-city" type="button" style="padding:10px 16px;min-height:44px;background:#1d4ed8;color:#fff;border-radius:8px">Use my location</button><p id="city-location-status" role="status" style="font-size:14px;margin-top:8px"></p><div id="city-options" aria-label="Cities" style="display:flex;flex-wrap:wrap;max-height:30dvh;overflow:auto;margin-top:8px"></div></div></section>';

  return new Promise<void>(resolve => {
    let map: import("maplibre-gl").Map | undefined;
    let finished = false;
    const select = (city: CityConfig) => {
      if (finished || (offline && !installed.has(city.id))) return;
      finished = true;
      // Zustand's persisted shape; the store later resolves current metadata by ID.
      try { localStorage.setItem("ptn-city", JSON.stringify({state: {activeCity: city}, version: 0})); } catch { /* Optional storage. */ }
      // Also select in memory when persistence is unavailable.
      void import("./stores/cityStore.ts").then(({useCityStore}) => {
        useCityStore.getState().setActiveCity(city);
        map?.remove();
        root.replaceChildren();
        resolve();
      });
    };
    for (const city of cities) {
      const button = document.createElement("button");
      button.textContent = `${city.name}${downloaded.has(city.id) ? " · Downloaded" : installed.has(city.id) ? " · Cached" : offline ? " · Connect to download" : ""}`;
      button.disabled = offline && !installed.has(city.id);
      button.style.cssText = "padding:8px;margin:4px;border:1px solid currentColor;border-radius:8px";
      button.onclick = () => select(city);
      document.getElementById("city-options")!.append(button);
    }
    const status = document.getElementById("city-location-status")!;
    if (offline) status.textContent = "No connection. Only cities with data on this device can be opened.";
    document.getElementById("locate-city")!.onclick = () => {
      if (!navigator.geolocation) { status.textContent = "Location is unavailable. Choose a city on the map or list."; return; }
      status.textContent = "Finding nearby coverage…";
      navigator.geolocation.getCurrentPosition(position => {
        if (finished) return;
        const {latitude: lat, longitude: lon} = position.coords;
        const matches = cities.filter(c => lat >= c.bbox.minLat && lat <= c.bbox.maxLat && lon >= c.bbox.minLon && lon <= c.bbox.maxLon);
        if (matches.length === 1 && (!offline || installed.has(matches[0].id))) select(matches[0]);
        else {
          status.textContent = matches.length ? "Choose one of the cities near your location." : "No served city covers your location. Choose a city on the map or list.";
          map?.easeTo({center: [lon, lat], zoom: 3});
        }
      }, () => { if (!finished) status.textContent = "Location is unavailable. Choose a city on the map or list."; }, {timeout: 10000});
    };
    // List selection remains usable if WebGL or basemap access is unavailable.
    void Promise.all([import("./map/maplibre.ts"), import("./map/styleBuilder.ts")]).then(([{default: maplibre}, {buildLocalStyle}]) => {
      if (finished) return;
      map = new maplibre.Map({container: "city-world-map", style: buildLocalStyle(false), center: [0, 20], zoom: 1});
      const overview = map;
      overview.once("idle", () => {root.dataset.cityMapReady = "true";});
      overview.on("load", () => {
        overview.addSource("world-land", {type: "geojson", attribution: "Made with Natural Earth", data: worldLand as unknown as GeoJSON.FeatureCollection});
        overview.addLayer({id: "world-land", type: "fill", source: "world-land", paint: {"fill-color": "#d5dfd2"}});
        overview.addSource("cities", {type: "geojson", data: {type: "FeatureCollection", features: cityOverviewFeatures(cities)}, cluster: true, clusterRadius: 44, clusterMaxZoom: 8});
        overview.addLayer({id: "city-clusters", type: "circle", source: "cities", filter: ["has", "point_count"], paint: {"circle-color": "#1d4ed8", "circle-radius": 18, "circle-stroke-color": "white", "circle-stroke-width": 3}});
        overview.addLayer({id: "city-dots", type: "circle", source: "cities", filter: ["!", ["has", "point_count"]], paint: {"circle-color": "#1d4ed8", "circle-radius": ["get", "radius"], "circle-stroke-color": "white", "circle-stroke-width": 2}});
        overview.addLayer({id: "city-targets", type: "circle", source: "cities", filter: ["!", ["has", "point_count"]], paint: {"circle-radius": 22, "circle-opacity": 0}});
        overview.on("click", "city-clusters", event => {
          const geometry = event.features?.[0].geometry as GeoJSON.Point | undefined;
          if (geometry) overview.easeTo({center: geometry.coordinates as [number, number], zoom: overview.getZoom() + 2});
        });
        overview.on("click", "city-targets", event => {
          const city = cities.find(city => city.id === event.features?.[0].properties?.cityId);
          if (city) select(city);
        });
        for (const layer of ["city-clusters", "city-targets"]) {
          overview.on("mouseenter", layer, () => {overview.getCanvas().style.cursor = "pointer";});
          overview.on("mouseleave", layer, () => {overview.getCanvas().style.cursor = "";});
        }
      });
    }).catch(() => { if (!finished) status.textContent = "Map unavailable. Choose a city from the list."; });
  });
}
