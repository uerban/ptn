import {discoverCities, catalogWasCached} from "./config/discovery.ts";
import {classifyInstallation} from "./services/installClassifier.ts";
import "./index.css";

async function start(): Promise<void> {
  // Before any store module loads: hydration rewrites the stored state the
  // classification reads.
  try { classifyInstallation(); } catch { /* Storage unavailable: setup runs on session state. */ }
  // Production always attempts backend discovery, including legacy deployments.
  const cities = import.meta.env.DEV
    ? (await import("./config/cities.ts")).getAvailableCities()
    : await discoverCities();
  const {installCityCatalog} = await import("./config/cities.ts");
  installCityCatalog(cities);
  // Register the app shell while the first-launch picker is displayed too.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  const {chooseInitialCity} = await import("./chooseInitialCity.ts");
  await chooseInitialCity(cities, catalogWasCached);
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
