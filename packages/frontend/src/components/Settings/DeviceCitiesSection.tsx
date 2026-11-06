import {useEffect, useState} from "react";
import {getAvailableCities} from "../../config/cities.ts";
import {useCityStore} from "../../stores/cityStore.ts";
import {useGtfsDataStore} from "../../stores/gtfsDataStore.ts";
import {listDeviceCities, removeDeviceCity, saveDeviceCity} from "../../services/deviceCities.ts";
import type {OfflineCityRecord} from "../../db/index.ts";

export function DeviceCitiesSection() {
  const activeCity = useCityStore(state => state.activeCity);
  const [selected, setSelected] = useState(activeCity.id);
  const [downloads, setDownloads] = useState<OfflineCityRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = () => listDeviceCities().then(setDownloads);
  useEffect(() => { void refresh(); }, []);
  async function download() {
    setBusy(true);
    setMessage("Downloading timetable and walking transfers…");
    try {
      const city = getAvailableCities().find(city => city.id === selected)!;
      if (!navigator.onLine) throw new Error("Connect to download a city");
      const gtfs = useGtfsDataStore.getState();
      if (gtfs.syncing) throw new Error("Wait for the current city to finish loading");
      await gtfs.reset();
      useCityStore.getState().setActiveCity(city);
      await useGtfsDataStore.getState().init(city.id);
      if (useGtfsDataStore.getState().loadedCityId !== city.id) throw new Error(useGtfsDataStore.getState().error ?? "City download failed");
      await useGtfsDataStore.getState().ensureWasmReady(city.id, {preferCache: true});
      await saveDeviceCity(city);
      await refresh();
      setMessage("Timetable saved on this device. Use Prepare for offline below to download additional schedule tiles and places. Live updates need a connection.");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <section className="space-y-2 py-3" aria-label="Cities on this device">
    <h2 className="text-sm font-semibold">Cities on this device</h2>
    <p className="text-xs">Download a city while connected to keep its timetable when switching cities offline. Downloads use device storage and can become outdated.</p>
    <select aria-label="City to download" value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>
      {getAvailableCities().map(city => <option key={city.id} value={city.id}>{city.name}</option>)}
    </select>
    <button type="button" disabled={busy} onClick={() => void download()}>Open and download</button>
    <p role="status" className="text-xs">{message}</p>
    <ul>{downloads.map(download => <li key={download.cityId} className="text-xs py-1">
      {download.city.name} · {(download.sizeBytes / 1_000_000).toFixed(1)} MB · {new Date(download.preparedAt).toLocaleDateString()}
      <button type="button" disabled={busy} onClick={() => {void removeDeviceCity(download.cityId).then(refresh);}}>Remove download</button>
    </li>)}</ul>
  </section>;
}
