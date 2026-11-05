import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { I18nProvider } from "./i18n/I18nProvider.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { AppErrorFallback } from "./components/AppErrorFallback.tsx";
import { installGlobalHandlers, reportError } from "./services/errorReporter.ts";
import { startWatchdog } from "./services/storagePolicy.ts";
import { registerScheduleTileEvictor } from "./services/scheduleTileEvictor.ts";
import { startRecentsSweep } from "./services/recents.ts";
import { startStopUsageSweep } from "./services/stopUsage.ts";
import { runPrivacyDataMigration } from "./services/privacyDataMigration.ts";
import { startDedupSweep } from "./services/geocoder/dedupCache.ts";
import { listenForSwUpdates } from "./services/poiLoader.ts";
import { loadGeocoderConfig, syncPoi } from "./bootPoi.ts";
import { useCityStore } from "./stores/cityStore.ts";
import { useSettingsStore } from "./stores/settingsStore.ts";
import { ensureDataSchemaUpToDate } from "./db/dataSchemaVersion.ts";
import { scheduleIdle } from "./utils/idle.ts";
import "./index.css";

installGlobalHandlers();

async function bootApp(): Promise<void> {
  // Run before mounting React so the wipe completes before any store
  // hydration or loader reads from IndexedDB. Common case (matching
  // version) is a single localStorage read.
  try {
    const result = await ensureDataSchemaUpToDate();
    if (result.kind === "wiped") {
      console.info(
        `[dataSchemaGuard] wiped cached data on schema-version bump (was ${result.previous})`,
      );
    } else if (result.kind === "wipe-incomplete") {
      // Per-table failures already routed to reportError inside the
      // guard. Logging here too makes the half-wipe loud during dev.
      console.warn(
        `[dataSchemaGuard] wipe incomplete; will retry on next boot. Failed tables:`,
        result.failed,
      );
    }
  } catch (err) {
    // Boot must not depend on the wipe.
    reportError(err instanceof Error ? err : new Error(String(err)), {
      context: { where: "main.ensureDataSchemaUpToDate" },
    });
  }

  // Legacy versions wrote optional history before a standing choice existed.
  // Clean it before React mounts; the marker is also the call-time writer gate.
  try {
    await runPrivacyDataMigration();
  } catch (err) {
    // Core transit remains usable. With no completion marker every optional
    // writer stays closed and the cleanup retries on the next launch.
    reportError(err instanceof Error ? err : new Error(String(err)), {
      context: { where: "main.runPrivacyDataMigration" },
    });
  }

  registerScheduleTileEvictor();

  scheduleIdle(async () => {
    void startWatchdog();
    startRecentsSweep();
    startStopUsageSweep();
    startDedupSweep();
    await loadGeocoderConfig();          // cache JSON + register BEFORE first sync
    useCityStore.subscribe(syncPoi);
    useSettingsStore.subscribe(syncPoi);
    syncPoi();                           // now hasServerSideGeocoder reads cached JSON
    listenForSwUpdates(
      () => useCityStore.getState().activeCity.id,
      () => useSettingsStore.getState().poiIncludeLooseTier,
    );
  });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary
        fallback={<AppErrorFallback onRetry={() => globalThis.location.reload()} />}
        context="root"
      >
        <I18nProvider>
          <App />
        </I18nProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}

void bootApp();
