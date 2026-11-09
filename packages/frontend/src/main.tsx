import {discoverCities, catalogWasCached} from "./config/discovery.ts";
import {classifyInstallation} from "./services/installClassifier.ts";
import "./index.css";

async function start(): Promise<void> {
  // Before any store module loads: hydration rewrites the stored state the
  // classification reads.
  try { classifyInstallation(); } catch { /* Storage unavailable: setup runs on session state. */ }
  // Production always attempts backend discovery, including legacy deployments.
  // A failed discovery leaves the catalog empty; the setup shell then offers
  // cities whose data is on this device, or a way to try again.
  const cities = import.meta.env.DEV
    ? (await import("./config/cities.ts")).getAvailableCities()
    : await discoverCities().catch(() => []);
  const {installCityCatalog} = await import("./config/cities.ts");
  if (cities.length) installCityCatalog(cities);
  // Register the app shell while setup is displayed too. The precache holds
  // the app shell only; map-only assets are fetched when Map is chosen.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  // Nothing optional may start before setup is complete: appMain (time sync,
  // geocoder boot, POI sync, live data) is imported only after the gate.
  const {runStartupGate} = await import("./setup/startupGate.ts");
  await runStartupGate({cities, catalogWasCached});
  await import("./appMain.tsx");
}

void start().catch(error => {
  const root = document.getElementById("root")!;
  root.replaceChildren();
  const message = document.createElement("p");
  message.textContent = `Unable to load this host's cities. ${error instanceof Error ? error.message : ""}`;
  const retry = document.createElement("button");
  retry.textContent = "Try again";
  retry.onclick = () => location.reload();
  root.append(message, retry);
});
