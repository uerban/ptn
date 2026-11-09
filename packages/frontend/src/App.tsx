import {installWalkGraphAdoption} from "./services/walkGraphAdoption.ts";
import { liveLocation } from "./services/liveLocation.ts";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Suspense, lazy, useEffect } from "react";
import { Layout } from "./components/Layout/Layout.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { UpdatePrompt } from "./components/UpdatePrompt.tsx";
import { useServerTimeSync } from "./hooks/useServerTimeSync.ts";
import { registerVisibilityChangeAlivenessGuard } from "./services/wasmLifecycle.ts";

// The dispatcher picks the Text or Map surface, each its own lazy chunk.
const HomePage = lazy(() =>
  import("./pages/HomeDispatcher.tsx").then((m) => ({ default: m.HomeDispatcher }))
);
const SearchPage = lazy(() =>
  import("./pages/Search.tsx").then((m) => ({ default: m.SearchPage }))
);
const SettingsPage = lazy(() =>
  import("./pages/Settings.tsx").then((m) => ({ default: m.SettingsPage }))
);
const LinePreviewPage = lazy(() =>
  import("./pages/LinePreview.tsx").then((m) => ({ default: m.LinePreviewPage }))
);

function RouteErrorFallback({ onReset }: { onReset?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm text-gray-600">Failed to load this page. Try going back.</p>
      {onReset && (
        <button
          onClick={onReset}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function App() {
  useEffect(() => installWalkGraphAdoption(), []);
  useEffect(() => liveLocation.subscribe(() => {}), []);
  // Sync `serverTime` from /version once at app boot. Mounted here, not
  // inside a page, so the side effect fires regardless of which route the
  // user lands on. See `useServerTimeSync.ts` for why /version is the
  // right source.
  useServerTimeSync();

  // Register the wasm-router aliveness guard. The guard reads cityId from the city store at
  // handler-time (panel engineer #4), so empty deps are correct — re-registration on city switch is
  // not required.
  useEffect(() => {
    const teardown = registerVisibilityChangeAlivenessGuard();
    return teardown;
  }, []);

  return (
    <BrowserRouter>
      <UpdatePrompt />
      <Routes>
        <Route element={<Layout />}>
          <Route
            path="/"
            element={
              <ErrorBoundary fallback={({ reset }) => <RouteErrorFallback onReset={reset} />} context="home">
                <Suspense fallback={<div className="flex-1 bg-surface-overlay" aria-label="Loading" />}>
                  <HomePage />
                </Suspense>
              </ErrorBoundary>
            }
          />
          <Route
            path="/search"
            element={
              <ErrorBoundary fallback={({ reset }) => <RouteErrorFallback onReset={reset} />} context="search">
                <Suspense fallback={<div className="p-4">Loading...</div>}>
                  <SearchPage />
                </Suspense>
              </ErrorBoundary>
            }
          />
          <Route
            path="/settings"
            element={
              <ErrorBoundary fallback={({ reset }) => <RouteErrorFallback onReset={reset} />} context="settings">
                <Suspense fallback={<div className="p-4">Loading...</div>}>
                  <SettingsPage />
                </Suspense>
              </ErrorBoundary>
            }
          />
          <Route
            path="/line/:routeId"
            element={
              <ErrorBoundary fallback={({ reset }) => <RouteErrorFallback onReset={reset} />} context="line">
                <Suspense fallback={<div className="p-4">Loading...</div>}>
                  <LinePreviewPage />
                </Suspense>
              </ErrorBoundary>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
