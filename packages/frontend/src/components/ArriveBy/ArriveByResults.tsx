import { useEffectiveExcludedModes } from "../../hooks/useEffectiveExcludedModes.ts";
/**
 * Opt-in Arrive-by results: while a deadline is applied, runs the selected
 * latest-then-portfolio search on the router's arrive-by channel and shows
 * its options in the existing results list, latest departure first. Without
 * an applied deadline it renders Search's normal results unchanged. Bundled
 * only in a `PTN_ARRIVE_BY_EXPERIMENT=1` build (`arriveByExperiment.ts`).
 *
 * H62 keeps a certified latest card only after a known resource limit in
 * the alternatives stage; integrity/context failures clear it. A running
 * request cannot be stopped (H61); leaving the deadline only stops delivery.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { BaseEndpoint, Itinerary } from "@pt/shared";
import { captureCityData } from "../../services/cityData.ts";
import { useTranslation } from "../../i18n/index.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { useRoutingStore } from "../../stores/routingStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import type { ArriveBySearchState } from "../../services/temporalArriveByClient.ts";
import type { ArriveByJourneyOption, ArriveByMovementScope } from "../../services/temporalArriveByJourneys.ts";
import { RouteResults } from "../RouteResults/RouteResults.tsx";
import { formatTime } from "../RouteResults/shared/format.ts";
import { arriveByCards, orderArriveByCards, type ArriveByCard } from "./arriveByItineraries.ts";
import { ARRIVE_BY_MARKS, markArriveBy } from "./arriveByMarks.ts";
import { prepareArriveBy, type ArriveByPrepared } from "./arriveByQuery.ts";
import { arriveByRouteColors } from "./arriveByTables.ts";
import type { ArriveByResultsProps } from "./arriveByTypes.ts";
import { useArriveByUi } from "./arriveByUiStore.ts";

type View =
  | { readonly kind: "preparing" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "no-stops" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "search"; readonly state: ArriveBySearchState; readonly scope: ArriveByMovementScope;
      readonly cards: readonly ArriveByCard[] };

export function ArriveByResults({ origin, destination, onSelect, children }: ArriveByResultsProps) {
  const appliedMs = useArriveByUi((s) => s.appliedMs);
  if (appliedMs === null || !origin || !destination) return <>{children}</>;
  return <AppliedArriveBy origin={origin} destination={destination} deadlineMs={appliedMs} onSelect={onSelect} />;
}

/** `status` only labels the H73 mark. An update without options has no
 * cards, so it reads nothing (H73 step 2). */
async function cardsFor(options: readonly ArriveByJourneyOption[], prepared: ArriveByPrepared, tz: string,
  labels: { origin: string; destination: string }, status: string): Promise<ArriveByCard[]> {
  const start = performance.now();
  if (options.length === 0) {
    markArriveBy(ARRIVE_BY_MARKS.cards, { status, start, tripsRead: start, routesRead: start, trips: 0, routes: 0, options: 0 });
    return [];
  }
  const data = captureCityData();
  let tripsRead = start, routesRead = start;
  const tripIds = [...new Set(options.flatMap((o) => o.journey.rides.map((r) => r.tripId)))];
  const [trips, routeColors] = await Promise.all([
    (tripIds.length > 0 ? data.gtfsTrips.bulkGet(tripIds) : Promise.resolve([])).then((rows) => { tripsRead = performance.now(); return rows; }),
    arriveByRouteColors().then((colors) => { routesRead = performance.now(); return colors; }),
  ]);
  data.assertCurrent();
  const headsigns = new Map<string, string>();
  for (const trip of trips) if (trip?.headsign) headsigns.set(trip.tripId, trip.headsign);
  const cards = arriveByCards(options, {
    serviceDate: prepared.input.scope.serviceDate, tz, origin: prepared.origin, destination: prepared.destination,
    labels, stops: prepared.stops, headsigns, routeColors, runToCatchStops: prepared.runToCatchStops,
  });
  markArriveBy(ARRIVE_BY_MARKS.cards, {
    status, start, tripsRead, routesRead, trips: tripIds.length, routes: routeColors.size, options: options.length,
  });
  return cards;
}

/** H73: a mark in the first frame after this commit's paint, if there is a frame clock. */
function markNextFrame(status: string): void {
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => setTimeout(() => markArriveBy(ARRIVE_BY_MARKS.frame, { status }), 0));
}

function AppliedArriveBy({ origin, destination, deadlineMs, onSelect }: {
  origin: BaseEndpoint; destination: BaseEndpoint; deadlineMs: number; onSelect: (itinerary: Itinerary) => void;
}) {
  const { t, locale } = useTranslation();
  const router = useGtfsDataStore((s) => s.ptRouter);
  const ranking = useRoutingStore((s) => s.ranking);
  const cityId = useCityStore((s) => s.activeCity.id);
  const tz = useCityStore((s) => s.activeCity.tz) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Every setting the query reads re-runs the search.
  const excludedModes = useEffectiveExcludedModes();
  const excludedRouteGroupsByCity = useSettingsStore((s) => s.excludedRouteGroupsByCity);
  const mobilityProfile = useSettingsStore((s) => s.mobilityProfile);
  const walkSpeedMps = useSettingsStore((s) => s.walkSpeedMps);
  const maxWalkSecs = useSettingsStore((s) => s.maxWalkSecs);
  const runToCatch = useSettingsStore((s) => s.runToCatch);
  const [view, setView] = useState<View>({ kind: "preparing" });
  const [attempt, setAttempt] = useState(0);
  const originLabel = t("route.origin", "Origin");
  const destinationLabel = t("route.destination", "Destination");

  useEffect(() => {
    markArriveBy(ARRIVE_BY_MARKS.effect, { deadlineMs });
    setView(router && !router.arriveBy ? { kind: "unavailable" } : { kind: "preparing" });
    const channel = router?.arriveBy;
    if (!router || !channel) return;
    let stale = false, sequence = 0;
    let cancel = (): void => {};
    const labels = { origin: originLabel, destination: destinationLabel };
    void (async () => {
      const result = await prepareArriveBy(origin, destination, deadlineMs, router);
      if (stale) return;
      if (result.kind === "no-stops") { setView({ kind: "no-stops" }); return; }
      const { prepared } = result;
      const scope = prepared.input.scope;
      const search = channel.search(prepared.input, (state) => {
        if (stale) return;
        if (state.status === "cancelled") {
          sequence++;
          setView({ kind: "preparing" });
          return;
        }
        const mine = ++sequence;
        void cardsFor(state.options, prepared, tz, labels, state.status).then((cards) => {
          if (!stale && mine === sequence) {
            markArriveBy(ARRIVE_BY_MARKS.view, { status: state.status });
            setView({ kind: "search", state, scope, cards });
          }
        }, (err: unknown) => {
          if (!stale && mine === sequence) setView({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        });
      });
      cancel = () => search.cancel();
    })().catch((err: unknown) => {
      if (!stale) setView({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    });
    return () => { stale = true; cancel(); };
  }, [router, origin, destination, deadlineMs, cityId, tz, excludedModes, excludedRouteGroupsByCity, mobilityProfile, walkSpeedMps, maxWalkSecs,
    runToCatch, attempt, originLabel, destinationLabel]);

  const ordered = useMemo(() => (view.kind === "search" ? orderArriveByCards(view.cards, ranking) : []), [view, ranking]);

  // After the commit that shows a result (not after the paint).
  useEffect(() => {
    if (view.kind === "preparing" || (view.kind === "search" && view.state.status === "pending")) return;
    if (view.kind !== "search") {
      markArriveBy(ARRIVE_BY_MARKS.shown, { status: view.kind, message: view.kind === "error" ? view.message : null });
      markNextFrame(view.kind);
      return;
    }
    const s = view.state;
    markArriveBy(ARRIVE_BY_MARKS.shown, {
      status: s.status, latestSource: s.latestSource, failure: s.failure, latestScan: s.latestScan,
      scope: view.scope, options: s.options, order: ordered.map((c) => c.key),
      cards: ordered.map((c) => ({ departureTime: c.itinerary.departureTime, arrivalTime: c.itinerary.arrivalTime })),
      marks: s.marks, ownerMarks: s.ownerMarks,
    });
    markNextFrame(s.status);
  }, [view, ordered]);

  const deadlineText = formatTime(new Date(deadlineMs).toISOString(), locale, tz);
  const leaveNow = (
    <button type="button" onClick={() => useArriveByUi.getState().chooseLeaveNow()}
      className="mt-3 w-full min-h-12 py-2 text-sm text-accent border border-accent rounded-lg hover:bg-accent/10">
      {t("arriveBy.leave_now_action", "Show journeys leaving now")}
    </button>
  );
  const notice = (text: string, actions?: ReactNode) => (
    <div className="p-6 text-center text-fg-muted text-sm" data-testid="arrive-by-notice">
      <p>{text}</p>
      {actions}
    </div>
  );

  let body: ReactNode;
  let status = "";
  if (view.kind === "unavailable") {
    body = notice(t("arriveBy.unavailable", "Arrive by is not available in this session."), leaveNow);
  } else if (view.kind === "no-stops") {
    body = notice(t("arriveBy.no_stops", "No transit stops within walking distance of origin or destination."));
  } else if (view.kind === "error" || (view.kind === "search" && view.state.status === "failed")) {
    const code = view.kind === "search" ? `${view.state.failure?.stage}/${view.state.failure?.code}` : "client";
    body = notice(t("arriveBy.failed", "The arrive-by search failed ({code}).").replace("{code}", code), (
      <>
        <button type="button" onClick={() => setAttempt((n) => n + 1)}
          className="mt-3 w-full min-h-12 py-2 text-sm text-accent border border-accent rounded-lg hover:bg-accent/10">
          {t("arriveBy.retry", "Try again")}
        </button>
        {leaveNow}
      </>
    ));
  } else if (view.kind === "search" && view.state.status === "complete" && ordered.length === 0) {
    body = notice(t("arriveBy.none", "No journey starting in the 4 hours before {time} arrives in time.")
      .replace("{time}", deadlineText), leaveNow);
  } else {
    const pending = view.kind !== "search" || view.state.status === "pending";
    status = pending
      ? t("arriveBy.searching", "Finding the latest departure that arrives by {time}…").replace("{time}", deadlineText)
      : view.state.status === "latest"
        ? t("arriveBy.latest_found", "Latest departure shown. Finding the other options…")
        : view.state.status === "limited"
          ? t("arriveBy.limited", "Latest departure found. Other route options couldn’t be calculated.")
          : t("arriveBy.complete", "Arriving by {time}: latest departure first, then by departure time.")
          .replace("{time}", deadlineText);
    body = (
      <>
        <RouteResults itineraries={ordered.map((c) => c.itinerary)} onSelect={onSelect} loading={pending}
          origin={origin} destination={destination} feedTz={tz} />
        {view.kind === "search" && view.state.status === "limited" && notice(
          t("arriveBy.limited_recovery", "Change the deadline or search settings to try a different search."), leaveNow,
        )}
      </>
    );
  }

  return (
    <div data-testid="arrive-by-results" data-status={view.kind === "search" ? view.state.status : view.kind}>
      <p role="status" className="px-4 pt-3 text-xs text-fg-secondary">{status}</p>
      {body}
    </div>
  );
}
