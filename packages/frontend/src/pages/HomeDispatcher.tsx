import { lazy, Suspense } from "react";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { GuidanceSessionProvider } from "../components/Guidance/GuidanceSession.tsx";
import { useTemporaryMap } from "../presentation/temporaryMap.ts";
import { usePresentationText } from "../i18n/presentationStrings.ts";

// Separate chunks: Text mode never loads the map surface, its MapLibre
// dependency or any other map-only module.
const MapHome = lazy(() => import("./Home.tsx").then((m) => ({ default: m.HomePage })));
const TextHome = lazy(() => import("./TextHome.tsx").then((m) => ({ default: m.TextHome })));

/**
 * The home route. The saved starting view (`scheduleMode`, shown as Text
 * mode) picks the surface; Text mode can open a temporary map
 * (`?view=map`) without changing it. Trip guidance runs above both, so it
 * keeps going when the user switches between them.
 */
export function HomeDispatcher() {
  const textMode = useSettingsStore((s) => s.scheduleMode);
  const temporaryMap = useTemporaryMap();
  const text = usePresentationText();
  const showMap = !textMode || temporaryMap.active;

  return (
    <GuidanceSessionProvider>
      <Suspense
        fallback={
          <div className="flex-1 h-full bg-surface-overlay" role="status" aria-label={text("presentation.loading")} />
        }
      >
        {showMap ? (
          <MapHome onBackToText={textMode ? temporaryMap.close : undefined} />
        ) : (
          <TextHome temporaryMap={temporaryMap} />
        )}
      </Suspense>
    </GuidanceSessionProvider>
  );
}
