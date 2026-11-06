import {discoverCities, catalogWasCached} from "./config/discovery.ts";
import "./index.css";

async function start(): Promise<void> {
  // Development builds and legacy inline catalogs retain their explicit setup.
  const config = globalThis.__PTN_DEPLOYMENT__ as {schemaVersion?: unknown} | null;
  const cities = import.meta.env.DEV || config?.schemaVersion === 1 || config?.schemaVersion === 2
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
