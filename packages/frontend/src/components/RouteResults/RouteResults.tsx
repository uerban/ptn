import { useRef, useCallback, useMemo, useState } from "react";
import type { BaseEndpoint, Itinerary } from "@pt/shared";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n/index.ts";
import {
  useSettingsStore,
  selectPreStopBufferSeconds,
  selectRunSpeedRatio,
} from "../../stores/settingsStore.ts";
import { useServerNow } from "../../hooks/useServerNow.ts";
import { useRetainRoutes } from "../../hooks/useLiveRt.ts";
import { saveRoutePair } from "../../services/saves.ts";
import { SavedStorageNote } from "../Privacy/PersonalStorageNotice.tsx";
import { reportError } from "../../services/errorReporter.ts";
import { EngineFailureNotice } from "./EngineFailureNotice.tsx";
import { TransitousPanel, type TransitousPanelProps } from "./TransitousPanel.tsx";
import { RouteResultsConsumer } from "./RouteResultsConsumer.tsx";
import { RouteResultsPower } from "./RouteResultsPower.tsx";
import { RouteResultsAccessible } from "./RouteResultsAccessible.tsx";
import { ServiceAlertsPanel } from "../ServiceAlerts/ServiceAlertsPanel.tsx";
import { legTargets } from "../../hooks/useServiceAlertSelection.ts";
import { useCityStore } from "../../stores/cityStore.ts";

/** How often the result cards re-read the time. */
const RESULTS_CLOCK_MS = 10_000;

interface RouteResultsProps {
  itineraries: Itinerary[];
  onSelect: (itinerary: Itinerary) => void;
  loading?: boolean;
  error?: string | null;
  /**
   * Engine-class failure (the routing engine itself couldn't load/decode/plan).
   * Distinct from `error` because the recovery surface is different — engine
   * errors come from the wasm bundle pipeline or the on-device planning
   * boundary, and the offered recovery is the consented remote search. When
   * set, takes precedence over `error` and renders the surface carrying
   * `data-testid="engine-error"`.
   */
  engineError?: string | null;
  /**
 * The classified engine-failure signal paired with `engineError`. Drives the headline + inline
 * diagnostic in `EngineFailureNotice`. Null when the failure couldn't be classified (renders
 * the "other" headline).
 */
  engineFailureKind?: import("../../services/engineFailure.ts").EngineFailureKind | null;
  /**
 * Present ⇒ remote routing is permitted (privacy ceiling) AND a handler is wired. Presence is
 * the single source of truth for the "Search on the server" affordance.
 */
  remoteSearch?: { onSearchOnServer: () => void };
  /**
 * The empty-state "try the server" affordance (on-device ran and found nothing). Distinct from
 * `remoteSearch`: this is a nicety, so it IS suppressed when the remote source is
 * probed-unavailable.
 */
  emptyRemoteSearch?: { onSearchOnServer: () => void };
  onEarlier?: () => void;
  onLater?: () => void;
  /** Origin endpoint; when set alongside `destination`, enables "Save this pair". */
  origin?: BaseEndpoint | null;
  /** Destination endpoint; see `origin`. */
  destination?: BaseEndpoint | null;
  /**
   * Feed/agency timezone (IANA) of the active city. When set, result time
   * labels render in the feed tz (cross-tz-correct). Forwarded to whichever
   * variant renders. Absent → device-tz labels (legacy local-user path).
   */
  feedTz?: string;
  /**
 * The remote source returned reachable-but-empty: the server has no route for this trip. A
 * distinct state from the generic empty — it does NOT offer "search on the server" (we just
 * did) and does NOT retry on-device. Only ever set by the `remote-primary` path in Search.tsx.
 */
  serverEmpty?: boolean;
  /** When present, Search has selected transitous as the standing remote
   * provider and passed the live privacy double-gate. */
  transitous?: TransitousPanelProps;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function RouteResults({
  itineraries,
  onSelect,
  loading,
  error,
  engineError,
  engineFailureKind,
  remoteSearch,
  emptyRemoteSearch,
  onEarlier,
  onLater,
  origin,
  destination,
  feedTz,
  serverEmpty,
  transitous,
}: RouteResultsProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const variant = useSettingsStore((s) => s.routeSearchVariant);
  // Resolved pre-stop buffer in seconds (profile default unless user override is set).
  const bufferSeconds = useSettingsStore(selectPreStopBufferSeconds);
  const runSpeedRatio = useSettingsStore(selectRunSpeedRatio);
  // A clock, not a snapshot of the search: leave times come due and a bus
  // turns from "leave at" into "hurry" into "likely miss" while the list sits
  // open. Every copy it drives is minute-grained, so a tick every
  // RESULTS_CLOCK_MS keeps it honest without re-rendering the cards per second.
  const referenceNowMs = useServerNow(RESULTS_CLOCK_MS);
  // Live RT for each result's first ride — the one its leave time, catch
  // status and live badge hang on — while the list is open. Later rides stay
  // on the timetable: polling every route of every result costs the operator
  // a request per route per interval for data nobody acts on yet.
  useRetainRoutes(
    itineraries.flatMap((it) => {
      const routeId = it.legs.find((l) => l.mode !== "WALK")?.routeId;
      return routeId ? [routeId] : [];
    }),
  );
  const [savedDurably, setSavedDurably] = useState(true);
  const cityId = useCityStore((s) => s.activeCity.id);
  const cityName = useCityStore((s) => s.activeCity.name);
  const alertTargets = useMemo(
    () => itineraries.flatMap((it) => it.legs.flatMap(legTargets)),
    [itineraries],
  );

  const canSavePair = Boolean(origin && destination) && itineraries.length > 0;

  const handleSavePair = useCallback(async () => {
    if (!origin || !destination) return;
    setSaveState("saving");
    try {
      const alias =
        typeof window !== "undefined" && typeof window.prompt === "function"
          ? (window.prompt(
              t("search.save_pair_prompt", "Name this pair (optional)"),
              "",
            ) ?? "")
          : "";
      const { stored } = await saveRoutePair({ origin, destination, alias });
      setSavedDurably(stored === "stored");
      setSaveState("saved");
    } catch (err) {
      // Causes vary — crypto OperationError (install key missing), IDB
      // QuotaExceededError, constraint violations. Log so user bug reports
      // are debuggable; the UI still surfaces the generic retry message.
      reportError(err instanceof Error ? err : new Error(String(err)), {
        context: {
          surface: "routeResults.savePair",
          originKind: origin.kind,
          destKind: destination.kind,
        },
      });
      setSaveState("error");
    }
  }, [origin, destination, t]);

  // US-037: arrow-key convenience only. This surface used to declare
  // role="listbox" here and attribute-mutate role="option" + a roving
  // tabindex onto the variant cards; both were wrong and VoiceOver on macOS
  // announced the results as an empty scrollable list:
  //
  //   * a listbox owns only `option` (or `group` > `option`) children, and
  //     every variant nests its cards under at least one generic <div>, so
  //     the options were never owned by the listbox;
  //   * the wrapper also held content that is illegal inside a listbox and
  //     unreachable from one — the tz indicator, the mobility status banner,
  //     the per-card RT warning banners, the save-pair checkbox and button,
  //     Earlier/Later and the Appearance link;
  //   * the roles were written post-paint from an effect, so the first AX
  //     tree Safari cached had none of them.
  //
  // The cards are navigation targets, not the options of a single-select
  // widget, so the semantics now live in the variants as a real
  // <ul role="list"> of <li>-wrapped buttons and every card stays in the tab
  // order. Arrow keys still move focus between cards as a nicety.
  const handleResultsKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const container = listRef.current;
    if (!container) return;
    const cards = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="itinerary-card"]'),
    );
    if (cards.length === 0) return;
    const idx = cards.indexOf(document.activeElement as HTMLElement);
    // Focus is outside the card list (e.g. on Save this pair) — leave the
    // browser's own arrow behaviour alone rather than yanking focus back.
    if (idx === -1) return;

    e.preventDefault();
    const next =
      e.key === "ArrowDown"
        ? idx < cards.length - 1
          ? idx + 1
          : 0
        : idx > 0
          ? idx - 1
          : cards.length - 1;
    cards[next]?.focus();
  }, []);

  if (engineError) {
    // Engine-class failure (wasm bundle load/decode/dispatch error).
    // `EngineFailureNotice` carries `data-testid="engine-error"` — the e2e hook
    // for `e2e/core/wasm-engine-failure.spec.ts`. The engine-error branch takes
    // precedence over the generic `error` branch so a routing-store run that
    // produced an engine error doesn't fall back to an unrelated message.
    return (
      <>
        <EngineFailureNotice
          message={engineError}
          kind={engineFailureKind ?? null}
          remoteSearch={remoteSearch}
        />
        {transitous ? <TransitousPanel {...transitous} /> : null}
      </>
    );
  }
  if (error) {
    return <div className="p-4 text-center text-danger text-sm">{error}</div>;
  }

  if (loading) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-20 bg-surface-overlay rounded-xl animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (itineraries.length === 0) {
    if (serverEmpty) {
      return (
        <div className="p-6 text-center text-fg-muted" data-testid="server-no-route">
          {t("routing.server_no_route", "The server found no route for this trip.")}
        </div>
      );
    }
    return (
      <div className="p-6 text-center text-fg-muted">
        {t(
          "search.no_routes",
          "No routes found. Try a different time or destination.",
        )}
        {emptyRemoteSearch ? (
          <button
            type="button"
            data-testid="empty-search-server"
            onClick={emptyRemoteSearch.onSearchOnServer}
            className="mt-3 w-full py-2 text-sm text-accent border border-accent rounded-lg hover:bg-accent/10"
          >
            {t("search.search_on_server", "Search on the server instead")}
          </button>
        ) : null}
        {transitous ? <TransitousPanel {...transitous} /> : null}
      </div>
    );
  }

  return (
    <>
    <div ref={listRef} className="pt-2" onKeyDown={handleResultsKeyDown}>
      {/* The alerts' state and the offer; each card lists its own alerts. */}
      <ServiceAlertsPanel
        cityId={cityId}
        cityName={cityName}
        targets={alertTargets}
        surface="route-results"
        listAlerts={false}
      />
      {variant === "power" ? (
        <RouteResultsPower
          itineraries={itineraries}
          onSelect={onSelect}
          referenceNowMs={referenceNowMs}
          bufferSeconds={bufferSeconds}
          runSpeedRatio={runSpeedRatio}
          feedTz={feedTz}
        />
      ) : variant === "accessible" ? (
        <RouteResultsAccessible
          itineraries={itineraries}
          onSelect={onSelect}
          referenceNowMs={referenceNowMs}
          bufferSeconds={bufferSeconds}
          runSpeedRatio={runSpeedRatio}
          feedTz={feedTz}
        />
      ) : (
        <RouteResultsConsumer
          itineraries={itineraries}
          onSelect={onSelect}
          referenceNowMs={referenceNowMs}
          bufferSeconds={bufferSeconds}
          runSpeedRatio={runSpeedRatio}
          feedTz={feedTz}
        />
      )}

      {canSavePair && (
        <div className="px-3 pt-1 pb-2 space-y-2">
          <button
            type="button"
            onClick={handleSavePair}
            disabled={saveState === "saving" || saveState === "saved"}
            aria-label={t("search.save_pair", "Save this pair")}
            className="w-full py-2 text-sm text-accent border border-accent rounded-lg
              hover:bg-accent/10 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {saveState === "saved"
              ? t("search.save_pair_saved", "Saved")
              : saveState === "saving"
                ? t("search.save_pair_saving", "Saving…")
                : saveState === "error"
                  ? t("search.save_pair_error", "Couldn't save — try again")
                  : t("search.save_pair", "Save this pair")}
          </button>
          {saveState === "saved" && <SavedStorageNote durable={savedDurably} />}
        </div>
      )}

      {itineraries.length > 0 && (
        <>
          <div className="flex gap-2 px-3 pb-2">
            {onEarlier && (
              <button
                onClick={onEarlier}
                className="flex-1 py-2 text-sm text-accent border border-accent rounded-lg hover:bg-accent/10"
              >
                ↑ {t("search.earlier", "Earlier")}
              </button>
            )}
            {onLater && (
              <button
                onClick={onLater}
                className="flex-1 py-2 text-sm text-accent border border-accent rounded-lg hover:bg-accent/10"
              >
                {t("search.later", "Later")} ↓
              </button>
            )}
          </div>
          <div className="px-3 pb-3 flex items-center justify-end">
            <Link
              to="/settings#appearance"
              className="text-xs font-medium text-fg-secondary hover:text-fg underline-offset-2 hover:underline"
            >
              {t("search.appearance_link", "Appearance…")}
            </Link>
          </div>
        </>
      )}
    </div>
    </>
  );
}
