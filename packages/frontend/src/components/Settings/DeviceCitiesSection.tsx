import {useEffect, useState} from "react";
import {getAvailableCities} from "../../config/cities.ts";
import {useCityStore} from "../../stores/cityStore.ts";
import {useRtStore} from "../../stores/rtStore.ts";
import {useGtfsDataStore} from "../../stores/gtfsDataStore.ts";
import {listDeviceCities, removeDeviceCity, saveDeviceCity} from "../../services/deviceCities.ts";
import type {OfflineCityMetadata} from "../../db/index.ts";

export function DeviceCitiesSection() {
  const activeCity = useCityStore(state => state.activeCity);
  const [selected, setSelected] = useState(activeCity.id);
  const [downloads, setDownloads] = useState<OfflineCityMetadata[]>([]);
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
      useRtStore.getState().unsubscribeAll();
      await gtfs.reset();
      useCityStore.getState().setActiveCity(city);
      await useGtfsDataStore.getState().refresh(city.id, {requireNetwork: true});
      if (useGtfsDataStore.getState().error || useGtfsDataStore.getState().loadedCityId !== city.id) throw new Error(useGtfsDataStore.getState().error ?? "City download failed");
      await useGtfsDataStore.getState().ensureWasmReady(city.id, {preferCache: true});
      await saveDeviceCity(city);
      await refresh();
      setMessage("Timetable saved on this device. Use Prepare for offline below to download additional schedule tiles and places. Live updates need a connection.");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function open(cityId: string) {
    setBusy(true);
    setMessage("");
    try {
      const city = getAvailableCities().find(city => city.id === cityId);
      if (!city) throw new Error("This city is no longer exposed by this deployment");
      if (useGtfsDataStore.getState().syncing) throw new Error("Wait for the current city to finish loading");
      useRtStore.getState().unsubscribeAll();
      await useGtfsDataStore.getState().reset();
      useCityStore.getState().setActiveCity(city);
      await useGtfsDataStore.getState().init(city.id, {preferDownload: true});
      const state = useGtfsDataStore.getState();
      if (state.error || state.loadedCityId !== city.id) throw new Error(state.error ?? "City could not be opened");
      await state.ensureWasmReady(city.id, {preferCache: true});
      setMessage("Opened downloaded timetable. Live updates need a connection.");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function remove(cityId: string) {
    setBusy(true);
    try { await removeDeviceCity(cityId); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
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
    <ul>{downloads.map(download => {
      const name = getAvailableCities().find(city => city.id === download.cityId)?.name ?? download.city?.name ?? download.cityId;
      return <li key={download.cityId} className="text-xs py-1">
        {name}{download.sizeBytes !== undefined && ` · ${(download.sizeBytes / 1_000_000).toFixed(1)} MB`}
        {download.preparedAt !== undefined && ` · ${new Date(download.preparedAt).toLocaleDateString()}`}
        <button type="button" disabled={busy || !getAvailableCities().some(city => city.id === download.cityId)} onClick={() => void open(download.cityId)}>Open {name}</button>
        <button type="button" disabled={busy} onClick={() => void remove(download.cityId)}>Remove download</button>
      </li>;
    })}</ul>
  </section>;
}
