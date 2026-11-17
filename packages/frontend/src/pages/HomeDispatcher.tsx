import { lazy, Suspense, useCallback, useState } from "react";
import type { Stop } from "@pt/shared";
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
 * keeps going when the user switches between them. The stop whose departures
 * Text mode shows is kept here too: the temporary map opens on it, and
 * coming back to text shows it again.
 */
export function HomeDispatcher() {
  const textMode = useSettingsStore((s) => s.scheduleMode);
  const temporaryMap = useTemporaryMap();
  const { close: closeTemporaryMap } = temporaryMap;
  // Leaving Text mode from its temporary map: Map mode becomes the starting
  // view and the `?view=map` entry is dropped, so a later switch back to
  // Text mode opens on text, not on a stale temporary map.
  const switchToMap = useCallback(() => {
    useSettingsStore.getState().setScheduleMode(false);
    closeTemporaryMap();
  }, [closeTemporaryMap]);
  const text = usePresentationText();
  const showMap = !textMode || temporaryMap.active;
  const [textStop, setTextStop] = useState<Stop | null>(null);

  return (
    <GuidanceSessionProvider>
      <Suspense
        fallback={
          <div className="flex-1 h-full bg-surface-overlay" role="status" aria-label={text("presentation.loading")} />
        }
      >
        {showMap ? (
          <MapHome
            onBackToText={textMode ? temporaryMap.close : undefined}
            onSwitchToMap={textMode ? switchToMap : undefined}
            contextStop={textMode ? textStop : null}
          />
        ) : (
          <TextHome temporaryMap={temporaryMap} selectedStop={textStop} onSelectStop={setTextStop} />
        )}
      </Suspense>
    </GuidanceSessionProvider>
  );
}
