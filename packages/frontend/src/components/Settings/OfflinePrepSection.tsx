import { useMemo, useRef, useState } from "react";
import { useTranslation, loadLocale, loadPrivacyNamespace } from "../../i18n/index.ts";
import { usePrivacyStore } from "../../stores/privacyStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { resolvePoiFetchMode } from "../../services/poiFetchMode.ts";
import {
  planOfflinePrep,
  runOfflinePrep,
  type OfflinePrepProgress,
  type OfflinePrepResult,
} from "../../services/offlinePrep.ts";
import { scheduleTileCoordsForBbox } from "../../services/offlinePrepTiles.ts";
import { SCHEDULE_TILE_SIZE_LABEL } from "@pt/shared/poi";

type Phase = "idle" | "confirming" | "running" | "done";

export function OfflinePrepSection() {
  const { t, locale } = useTranslation();
  const level = usePrivacyStore((s) => s.level);
  const activeCity = useCityStore((s) => s.activeCity);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<OfflinePrepProgress | null>(null);
  const [result, setResult] = useState<OfflinePrepResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const poiMode = resolvePoiFetchMode(activeCity.id);
  const plan = useMemo(
    () => planOfflinePrep({ level, poiMode }),
    [level, poiMode],
  );

  async function start() {
    setPhase("running");
    setResult(null);
    setProgress(null);
    const controller = new AbortController();
    abortRef.current = controller;

    // Imported here rather than at module scope so the Settings chunk does not
    // drag the schedule-tile read path — the very graph this button warms.
    const [readPath, cache, bootPoi] = await Promise.all([
      import("../../services/scheduleTileReadPath.ts"),
      import("../../services/scheduleTileCache.ts"),
      import("../../bootPoi.ts"),
    ]);

    const r = await runOfflinePrep(
      plan,
      {
        warmI18n: async () => {
          await Promise.all([loadLocale(locale), loadPrivacyNamespace(locale)]);
        },
        warmManifest: readPath.warmManifest,
        getManifest: () => {
          const manifest = readPath.currentManifest();
          const bundleHash = readPath.currentBundleHash();
          return manifest && bundleHash ? { manifest, bundleHash } : null;
        },
        tileCoordsToWarm: async () => {
          const manifest = readPath.currentManifest();
          return manifest
            ? scheduleTileCoordsForBbox(activeCity.bbox, manifest)
            : [];
        },
        warmTile: async (tileCoord, shared) => {
          const got = await cache.getDecodedTile(
            shared.bundleHash,
            SCHEDULE_TILE_SIZE_LABEL,
            tileCoord,
            // prewarm: this is a speculative fill, so it must not reorder the
            // LRU against tiles the user actually opened.
            { prewarm: true },
          );
          return "bytesDownloaded" in got ? got.bytesDownloaded : 0;
        },
        warmPoi: plan.steps.includes("poi")
          ? async () => bootPoi.forcePoiResync()
          : undefined,
      },
      setProgress,
      controller.signal,
    );
    setResult(r);
    setPhase("done");
  }

  const heading = t("settings.offline_prep", "Prepare for offline");

  return (
    <section aria-labelledby="settings-offline-prep-heading">
      <h2
        id="settings-offline-prep-heading"
        className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2"
      >
        {heading}
      </h2>
      <div className="bg-surface-raised rounded-xl border border-divider px-4 py-3 space-y-2">
        <p className="text-xs text-fg-secondary">
          {t(
            "settings.offline_prep_desc",
            "Download this city's timetable data now, so route planning keeps working where there is no signal.",
          )}
        </p>

        <ul className="text-xs text-fg-muted list-disc pl-4 space-y-0.5">
          {plan.restrictions.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>

        {phase === "confirming" && (
          <p className="text-xs text-fg italic">
            {t(
              "settings.offline_prep_confirm",
              "Your privacy level avoids downloading data you have not asked for. Preparing for offline will request this city's tiles now.",
            )}
          </p>
        )}

        {phase === "running" && progress && (
          <p className="text-xs text-fg-muted" aria-live="polite">
            {progress.step} — {progress.done}/{progress.total}
          </p>
        )}

        {phase === "done" && result && (
          <p className="text-xs text-fg" aria-live="polite">
            {result.cancelled
              ? t("settings.offline_prep_cancelled", "Stopped.")
              : result.ok
                ? t("settings.offline_prep_ready", "Ready for offline.")
                : t(
                    "settings.offline_prep_partial",
                    "Partly ready — some data could not be downloaded.",
                  )}{" "}
            {result.budgetExhausted
              ? t(
                  "settings.offline_prep_capped",
                  "Stopped at the download limit; the busiest area is covered.",
                )
              : null}
          </p>
        )}

        <div className="flex gap-2">
          {phase === "running" ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="text-xs underline underline-offset-2 text-fg-muted"
            >
              {t("settings.offline_prep_stop", "Stop")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (plan.requiresConfirmation && phase !== "confirming") {
                  setPhase("confirming");
                  return;
                }
                void start();
              }}
              className="text-xs underline underline-offset-2 text-accent"
            >
              {phase === "confirming"
                ? t("settings.offline_prep_go", "Download now")
                : heading}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
