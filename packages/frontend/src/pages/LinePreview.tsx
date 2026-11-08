import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { TransportMode } from "@pt/shared";
import { captureCityData } from "../services/cityData.ts";
import { buildLinePatterns } from "../utils/buildLinePatterns.ts";
import type { LinePattern } from "../stores/lineViewStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { getBadgeSize } from "../utils/appearance.ts";
import { useRtStore } from "../stores/rtStore.ts";
import { reportError } from "../services/errorReporter.ts";
import { useTranslation } from "../i18n/index.ts";
import { LineBadge } from "../components/RouteResults/shared/LineBadge.tsx";
import { LiveBadge } from "../components/RouteResults/shared/LiveBadge.tsx";
import { useCityStore } from "../stores/cityStore.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";

interface RouteMeta {
  id: string;
  shortName: string;
  mode: TransportMode;
  color?: string;
}

/**
 * Line preview page — displays a single transit route with its two directions,
 * ordered stop list, and realtime vehicle position (via RT store when present).
 *
 * Visual treatment follows the selected routeSearchVariant:
 *   - consumer (A): airy soft cards
 *   - power (B)   : dense mono rows, terminal vibes
 *   - accessible : inset cards, larger targets
 *
 * Fed from /line/:routeId. Optional ?dir=0|1 preselects a direction.
 */
export function LinePreviewPage() {
  const { routeId = "" } = useParams<{ routeId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const variant = useSettingsStore((s) => s.routeSearchVariant);
  const badgeSize = getBadgeSize(variant);
  const cityId = useCityStore((s) => s.activeCity.id);

  // Make sure GTFS data is loaded for the active city.
  useEffect(() => {
    useGtfsDataStore.getState().init(cityId);
  }, [cityId]);

  const [meta, setMeta] = useState<RouteMeta | null>(null);
  const [patterns, setPatterns] = useState<LinePattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirIdx, setDirIdx] = useState<number>(() => {
    const raw = searchParams.get("dir");
    if (raw === null) return 0;
    const parsed = Number(raw);
    // Reject `?dir=foo` (NaN) and negative values — clamp at display site.
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  });

  // Hold this route's live data without disturbing any other subscriber
  // (e.g. guidance on the same route): the store counts holders, so
  // releasing here never cuts guidance off. Returns the release.
  useEffect(() => {
    if (!routeId) return;
    return useRtStore.getState().retainRoutes([routeId]);
  }, [routeId]);

  useEffect(() => {
    if (!routeId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [route, built] = await Promise.all([
          captureCityData().gtfsRoutes.get(routeId),
          buildLinePatterns(routeId),
        ]);
        if (cancelled) return;
        if (!route) {
          setError(t("line.not_found", "Line not found"));
        } else {
          setMeta({
            id: route.id,
            shortName: route.shortName,
            mode: route.mode,
            color: route.color,
          });
          setPatterns(built);
        }
      } catch (err) {
        reportError(err instanceof Error ? err : new Error(String(err)), {
          context: { surface: "linePreview.load", routeId },
        });
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load line");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId, t]);

  // Peak delay across active trips on this route — feeds the header LiveBadge.
  // RT updates are per-trip (no per-stop breakdown), so we take the largest
  // absolute deviation to reflect "how late is this line running right now".
  const peakDelaySecs = useRtStore((s) => {
    const trips = s.updates.get(routeId);
    if (!trips || trips.length === 0) return undefined;
    let peak = 0;
    for (const trip of trips) {
      if (trip.cancelled) continue;
      if (Math.abs(trip.delaySeconds) > Math.abs(peak)) peak = trip.delaySeconds;
    }
    return peak;
  });

  const currentDir: LinePattern | undefined =
    patterns[Math.max(0, Math.min(dirIdx, patterns.length - 1))];
  const otherDir: LinePattern | undefined =
    patterns.length > 1 ? patterns[1 - dirIdx] : undefined;

  // The RT schema here is per-trip only (no per-stop data), so we can't
  // pinpoint a live vehicle position yet. Leave it null; the stop list
  // still renders without a "here" indicator.
  const vehicleStopIdx: number | null = null;

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 bg-surface">
        <div className="w-8 h-8 border-4 border-divider border-t-accent rounded-full animate-spin" />
        <div className="text-sm text-fg-muted">
          {t("line.loading", "Loading line…")}
        </div>
      </div>
    );
  }

  if (error || !meta) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 bg-surface p-6 text-center">
        <div className="text-sm text-danger">
          {error ?? t("line.not_found", "Line not found")}
        </div>
        <button
          onClick={() => navigate(-1)}
          className="text-sm text-accent underline"
        >
          {t("common.back", "Back")}
        </button>
      </div>
    );
  }

  const headsign = currentDir?.headsign ?? meta.shortName;

  return (
    <div className="h-full flex flex-col bg-surface overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-surface-raised border-b border-divider">
        <button
          onClick={() => navigate(-1)}
          aria-label={t("common.back", "Back")}
          className="p-2 -ml-2 rounded-full hover:bg-surface-overlay"
        >
          <svg
            className="w-5 h-5 text-fg-secondary"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>
        <LineBadge
          mode={meta.mode}
          label={meta.shortName}
          routeColor={meta.color}
          size={variant === "accessible" ? "lg" : "md"}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] tracking-widest text-fg-muted font-bold">
            {t("line.toward", "TOWARD")}
          </div>
          <div className="text-sm font-bold text-fg truncate">{headsign}</div>
        </div>
        {typeof peakDelaySecs === "number" && (
          <LiveBadge delaySeconds={peakDelaySecs} compact size={badgeSize} />
        )}
      </div>

      {/* Direction swap */}
      {patterns.length >= 2 && (
        <DirectionSwap
          patterns={patterns}
          dirIdx={dirIdx}
          setDirIdx={setDirIdx}
        />
      )}

      <div className="flex-1 overflow-y-auto">
        {!otherDir && patterns.length <= 1 && (
          <div className="px-4 py-2 text-xs text-fg-muted">
            {t(
              "line.single_direction",
              "This line operates in a single direction.",
            )}
          </div>
        )}

        {/* Stop list with vehicle position */}
        <StopList
          stops={currentDir?.stops ?? []}
          vehicleStopIdx={vehicleStopIdx}
          mode={meta.mode}
          routeColor={meta.color}
        />
      </div>
    </div>
  );
}

/**
 * Two-column direction swap: left column = direction 0, right = direction 1,
 * center button flips between them. Variant-aware chrome.
 */
function DirectionSwap({
  patterns,
  dirIdx,
  setDirIdx,
}: {
  patterns: LinePattern[];
  dirIdx: number;
  setDirIdx: (n: number) => void;
}) {
  const { t } = useTranslation();
  const variant = useSettingsStore((s) => s.routeSearchVariant);
  const d0 = patterns[0];
  const d1 = patterns[1];
  if (!d0 || !d1) return null;

  const fontScale =
    variant === "accessible" ? "text-sm" : variant === "power" ? "text-xs font-mono" : "text-sm";
  const minHeight = variant === "accessible" ? "min-h-[4rem]" : "min-h-[3rem]";

  return (
    <div
      role="group"
      aria-label={t("line.direction", "Direction")}
      className={`grid grid-cols-[1fr_auto_1fr] bg-surface-raised border-b border-divider ${fontScale}`}
    >
      <button
        onClick={() => setDirIdx(0)}
        aria-pressed={dirIdx === 0}
        className={`px-3 py-2.5 text-left transition-colors ${minHeight}
          ${dirIdx === 0 ? "bg-accent/10 text-accent" : "text-fg-muted hover:bg-surface-overlay"}`}
      >
        <div className="text-[10px] tracking-widest font-bold opacity-70">→</div>
        <div className="font-bold truncate mt-0.5">{d0.headsign}</div>
      </button>
      <button
        onClick={() => setDirIdx(1 - dirIdx)}
        aria-label={t("line.swap_direction", "Swap direction")}
        title={t("line.swap_direction", "Swap direction")}
        className="px-3 text-fg-muted border-x border-divider hover:text-accent hover:bg-surface-overlay"
      >
        <svg
          className="w-5 h-5 mx-auto"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M7 4v16M7 4l-3 3M7 4l3 3" />
          <path d="M17 20V4M17 20l-3-3M17 20l3-3" />
        </svg>
      </button>
      <button
        onClick={() => setDirIdx(1)}
        aria-pressed={dirIdx === 1}
        className={`px-3 py-2.5 text-right transition-colors ${minHeight}
          ${dirIdx === 1 ? "bg-accent/10 text-accent" : "text-fg-muted hover:bg-surface-overlay"}`}
      >
        <div className="text-[10px] tracking-widest font-bold opacity-70">←</div>
        <div className="font-bold truncate mt-0.5">{d1.headsign}</div>
      </button>
    </div>
  );
}

/**
 * Vertical stop list with a colored connector line. When vehicleStopIdx is
 * set, the matching stop is highlighted with a pulsing ring and a "vehicle
 * here" label. Past stops are struck through / dimmed.
 */
function StopList({
  stops,
  vehicleStopIdx,
  mode: _mode,
  routeColor,
}: {
  stops: { id: string; name: string }[];
  vehicleStopIdx: number | null;
  mode: TransportMode;
  routeColor: string | undefined;
}) {
  const { t } = useTranslation();
  const variant = useSettingsStore((s) => s.routeSearchVariant);
  const connectorColor = useMemo(() => {
    if (!routeColor) return "var(--color-accent)";
    return routeColor.startsWith("#") ? routeColor : `#${routeColor}`;
  }, [routeColor]);

  if (stops.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-fg-muted">
        {t("line.no_stops", "No stops available for this direction.")}
      </div>
    );
  }

  const rowPadding =
    variant === "accessible"
      ? "py-3"
      : variant === "power"
        ? "py-1.5"
        : "py-2";
  const fontSize =
    variant === "accessible"
      ? "text-base"
      : variant === "power"
        ? "text-[11px] font-mono"
        : "text-sm";

  return (
    <div className="px-4 py-3 relative">
      <div
        className="absolute top-4 bottom-4 w-0.5 opacity-40"
        style={{ left: "1.6rem", background: connectorColor }}
      />
      {stops.map((s, i) => {
        const isCurrent = vehicleStopIdx === i;
        const isPast = vehicleStopIdx !== null && i < vehicleStopIdx;
        return (
          <div
            key={`${s.id}-${i}`}
            className={`flex items-center gap-3 relative ${rowPadding}`}
          >
            <div className="w-6 flex-shrink-0 flex items-center justify-center">
              {isCurrent ? (
                <span
                  aria-hidden
                  className="block w-5 h-5 rounded-full border-[3px] animate-pulse"
                  style={{
                    borderColor: connectorColor,
                    background: "var(--color-surface)",
                    boxShadow: `0 0 0 3px ${connectorColor}33`,
                  }}
                />
              ) : (
                <span
                  aria-hidden
                  className="block w-2.5 h-2.5 rounded-full"
                  style={{
                    background: isPast ? connectorColor : "var(--color-surface)",
                    border: `2px solid ${connectorColor}`,
                    opacity: isPast ? 0.5 : 1,
                  }}
                />
              )}
            </div>
            <div
              className={`flex-1 min-w-0 truncate ${fontSize}
                ${isCurrent ? "font-bold text-fg" : isPast ? "text-fg-muted line-through opacity-70" : "text-fg-secondary"}`}
            >
              {s.name}
              {isCurrent && (
                <span
                  className="ml-2 text-[10px] tracking-widest font-extrabold"
                  style={{ color: connectorColor }}
                >
                  ← {t("line.vehicle_here", "HERE")}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

