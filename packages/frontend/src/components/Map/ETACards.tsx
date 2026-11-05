import { useCallback, useId, useMemo } from "react";
import type { Departure, StopWithLines } from "@pt/shared";
import { COUNTDOWN_INTERVAL_MS, POPUP_DEPARTED_CUTOFF_MINUTES } from "@pt/shared/constants";
import { useServerNow } from "../../hooks/useServerNow.ts";
import { minutesUntil } from "../../hooks/useCountdown.ts";
import { useTranslation } from "../../i18n/index.ts";
import { fill } from "../../i18n/fill.ts";
import type { EtaCardsLayout } from "../../stores/settingsStore.ts";
import { useRegisterMapObstacle } from "../../hooks/useRegisterMapObstacle.ts";
import { groupDeparturesByLine } from "../../utils/groupDeparturesByLine.ts";
import type { Row, Side } from "../../services/nearbyDirections.ts";
import { DepartureLineBadge } from "../DepartureLineBadge.tsx";
import { CHIPS_BOTTOM_VAR, CHIPS_RIGHT_VAR } from "./bottomControlInsets.ts";

/** Pills per row (`rows`), columns (`columns`). */
const MAX_PILLS = 10;

/** A side's stop, as the strip shows it. */
export interface EtaStopInfo {
  stop: StopWithLines;
  /** Metres from the user, following the live position. */
  distanceM: number;
}

interface ETACardsProps {
  /** Every line and direction to show, each in its row (`useNearbyDirections`). */
  sides: Side[];
  departuresBySide: Map<Side, Departure[]>;
  /** `S`: the top row's stop. */
  nearestStop: StopWithLines;
  /** Every side's stop. A side whose stop is missing here is not shown (`S` falls back to `nearestStop`). */
  stopInfo: ReadonlyMap<string, EtaStopInfo>;
  /** The nearest stop's departures are loading; the other stops fill in when ready. */
  loading: boolean;
  /** Two scroll rows, or one grid of a column per route (the `etaCardsLayout` setting). */
  layout: EtaCardsLayout;
  /** A pill was activated (click, or Enter/Space through the native button). */
  onSelect: (departure: Departure, stop: StopWithLines) => void;
}

interface PillDeparture {
  /** Unique within the strip: stop, line, direction and headsign. */
  key: string;
  /** The departure this pill shows, handed back through `onSelect`. */
  departure: Departure;
  /** The stop it leaves from. */
  stop: StopWithLines;
  /** Its effective (predicted, else scheduled) instant, epoch ms. */
  time: number;
  /** Minutes until `time`, rounded up; ≤ 0 reads "Due". */
  minutes: number;
}

/**
 * The soonest departure per route+headsign group of one side that has not
 * left yet. Cancelled departures and departed ones (past
 * `POPUP_DEPARTED_CUTOFF_MINUTES`) are dropped *before* grouping: this surface
 * is for "next vehicle coming", so a group shows its next run still to come,
 * and a group whose runs are all cancelled or gone shows nothing.
 *
 * Filtering after grouping would key the group on a trip nobody can take: the
 * helper's between-group sort would order it by a cancelled time, and a
 * departed first run would hide the group although its next run is minutes
 * away (tiles return departures back to ten minutes ago).
 */
function pickNextPerGroup(side: Side, departures: Departure[], stop: StopWithLines, now: number): PillDeparture[] {
  const pills: PillDeparture[] = [];
  const upcoming = departures.filter(
    (d) =>
      !d.cancelled &&
      minutesUntil(Date.parse(d.predictedTime ?? d.scheduledTime), now) >= POPUP_DEPARTED_CUTOFF_MINUTES,
  );
  for (const group of groupDeparturesByLine(upcoming)) {
    const next = group.departures[0];
    const time = Date.parse(next.predictedTime ?? next.scheduledTime);
    pills.push({
      key: `${side.stopId}::${side.routeId}::${side.dirKey}::${group.headsign}`,
      departure: next,
      stop,
      time,
      minutes: minutesUntil(time, now),
    });
  }
  return pills;
}

/**
 * The pills of one row over all its sides, soonest first. The sort is stable,
 * so equal times keep side order, then group order. Not capped: each layout
 * caps what it shows.
 */
function rowPills(
  row: Row,
  sides: Side[],
  departuresBySide: Map<Side, Departure[]>,
  stopFor: (id: string) => StopWithLines | undefined,
  now: number,
): PillDeparture[] {
  const pills: PillDeparture[] = [];
  for (const side of sides) {
    if (side.row !== row) continue;
    const stop = stopFor(side.stopId);
    if (!stop) continue;
    pills.push(...pickNextPerGroup(side, departuresBySide.get(side) ?? [], stop, now));
  }
  return pills.sort((a, b) => a.time - b.time);
}

/**
 * The stop that names the bottom row: the one carrying the most of its sides,
 * the first in side order on a tie. It depends on the sides only, so the
 * header does not flip as departures come and go.
 */
function bottomStopOf(
  sides: Side[],
  stopFor: (id: string) => StopWithLines | undefined,
): StopWithLines | null {
  const counts = new Map<string, number>();
  for (const side of sides) {
    if (side.row !== "bottom" || !stopFor(side.stopId)) continue;
    counts.set(side.stopId, (counts.get(side.stopId) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [id, n] of counts) {
    if (best === null || n > counts.get(best)!) best = id;
  }
  return best === null ? null : stopFor(best) ?? null;
}

interface Column {
  routeId: string;
  top: PillDeparture | null;
  bottom: PillDeparture | null;
}

/** A column's sort key: its soonest cell. */
const columnTime = (column: Column): number =>
  Math.min(column.top?.time ?? Infinity, column.bottom?.time ?? Infinity);

/**
 * The `columns` layout: one column per route over both rows, each cell the
 * route's soonest pill in that row, whatever its headsign or side (a route
 * with nothing in a row gets an empty cell). Columns are ordered by their
 * soonest cell — stable, so a tie keeps the top row's order first — and
 * capped at 10; a route with nothing left in either row has no column.
 */
function columnsOf(top: PillDeparture[], bottom: PillDeparture[]): Column[] {
  const byRoute = new Map<string, Column>();
  const place = (row: Row, pills: PillDeparture[]) => {
    // Rows are soonest first: a route's first pill in a row is its cell.
    for (const pill of pills) {
      const routeId = pill.departure.routeId;
      let column = byRoute.get(routeId);
      if (!column) {
        column = { routeId, top: null, bottom: null };
        byRoute.set(routeId, column);
      }
      column[row] ??= pill;
    }
  };
  place("top", top);
  place("bottom", bottom);
  return [...byRoute.values()]
    .sort((a, b) => columnTime(a) - columnTime(b))
    .slice(0, MAX_PILLS);
}

/**
 * Next departures near the user, as pills in up to two rows (see
 * `resolveNearbySides`): `top` = the nearest stop's side of the street — its
 * lines, and the other direction of the lines found across the street, which
 * may leave from a nearby stop of their own; `bottom` = the opposite
 * direction of the nearest stop's lines, plus the other lines serving those
 * stops. Each row scrolls on its own, soonest first, at most 10 pills; inside
 * a side, pills are one per route+headsign.
 *
 * When only the top row has something to show, the strip is the plain single
 * row, without a header. Whenever the bottom row shows, it is a group
 * labelled by its header ("Opposite direction" with the bottom row's main
 * stop) — also alone, so its pills are never read as the nearest stop's — and
 * the top row is labelled by the nearest stop's name and distance. A pill
 * names its own stop when that stop's name differs from its row's main stop's
 * (a same-name pole does not repeat the header).
 *
 * The `columns` layout lays both rows out as one grid in one scroller: a
 * column per route (see `columnsOf`), the two row labels in a sticky first
 * column, each pill described by its row's label. It needs both rows to
 * align anything, so with one row to show it renders as `rows` does.
 *
 * One server-synced clock drives the whole strip: which runs have left, and
 * every countdown, so a group's next run takes over the second its first one
 * is gone.
 */
export function ETACards({ sides, departuresBySide, nearestStop, stopInfo, loading, layout, onSelect }: ETACardsProps) {
  const { t } = useTranslation();
  const now = useServerNow(COUNTDOWN_INTERVAL_MS, !loading);

  const stopFor = useCallback(
    (id: string): StopWithLines | undefined =>
      stopInfo.get(id)?.stop ?? (id === nearestStop.id ? nearestStop : undefined),
    [stopInfo, nearestStop],
  );

  const top = useMemo(() => rowPills("top", sides, departuresBySide, stopFor, now), [sides, departuresBySide, stopFor, now]);
  const bottom = useMemo(
    () => rowPills("bottom", sides, departuresBySide, stopFor, now),
    [sides, departuresBySide, stopFor, now],
  );
  const bottomStop = useMemo(() => bottomStopOf(sides, stopFor), [sides, stopFor]);
  const columns = useMemo(
    () => (layout === "columns" ? columnsOf(top, bottom) : []),
    [layout, top, bottom],
  );

  const visibleCount = top.length + bottom.length;
  const obstacleRef = useRegisterMapObstacle<HTMLDivElement>(
    "eta-cards",
    !loading && visibleCount > 0,
  );

  if (loading || visibleCount === 0) return null;

  const distance = (id: string): string => {
    const info = stopInfo.get(id);
    if (!info) return "";
    return ` · ${fill(t("unit.meters", "{n} m"), { n: String(Math.round(info.distanceM)) })}`;
  };
  // Headers only when the opposite row shows: alone, the top row is the
  // strip as it always was.
  const headed = bottom.length > 0;
  const topHeader = `${nearestStop.name}${distance(nearestStop.id)}`;
  const bottomHeader = bottomStop
    ? `${t("eta.row_opposite", "Opposite direction")} · ${bottomStop.name}${distance(bottomStop.id)}`
    : "";

  return (
    <div
      ref={obstacleRef}
      data-testid="eta-cards"
      // Click-through: only the pills and headers take pointer events, so the
      // map (and its controls) stay usable beside a short row.
      className="absolute left-0 z-10 px-2 flex flex-col gap-1 pointer-events-none transition-[bottom] duration-200"
      // Same baseline as the map's attribution (i), clear of the bottom-right
      // controls; set by `trackBottomControlInsets` in TransitMap.
      style={{
        bottom: `var(${CHIPS_BOTTOM_VAR}, 4rem)`,
        right: `var(${CHIPS_RIGHT_VAR}, 0px)`,
      }}
    >
      {layout === "columns" && top.length > 0 && bottom.length > 0 && bottomStop ? (
        <ETAColumns
          columns={columns}
          labels={{ top: topHeader, bottom: bottomHeader }}
          mainStopNames={{ top: nearestStop.name, bottom: bottomStop.name }}
          onSelect={onSelect}
        />
      ) : (
        <>
          {top.length > 0 && (
            <ETARow
              row="top"
              header={headed ? topHeader : null}
              mainStopName={nearestStop.name}
              pills={top.slice(0, MAX_PILLS)}
              onSelect={onSelect}
            />
          )}
          {bottom.length > 0 && bottomStop && (
            <ETARow
              row="bottom"
              header={bottomHeader}
              mainStopName={bottomStop.name}
              pills={bottom.slice(0, MAX_PILLS)}
              onSelect={onSelect}
            />
          )}
        </>
      )}
    </div>
  );
}

interface ETAColumnsProps {
  columns: Column[];
  /** The row headers, shown in the sticky first column. */
  labels: Record<Row, string>;
  /** Per row: pills leaving from a stop of another name show that name. */
  mainStopNames: Record<Row, string>;
  onSelect: (departure: Departure, stop: StopWithLines) => void;
}

const ROWS: readonly Row[] = ["top", "bottom"];

/**
 * One grid (`grid-auto-flow: column`, two rows) inside one horizontal
 * scroller, so a route's two directions scroll together. The DOM runs column
 * by column (a route's top cell, then its bottom cell), and each pill is
 * described by its row's label, since there is no per-row group here.
 */
function ETAColumns({ columns, labels, mainStopNames, onSelect }: ETAColumnsProps) {
  const topId = useId();
  const bottomId = useId();
  const labelId: Record<Row, string> = { top: topId, bottom: bottomId };
  return (
    <div
      data-testid="eta-columns"
      className="grid grid-rows-2 grid-flow-col auto-cols-max gap-x-2 gap-y-1 overflow-x-auto scrollbar-hide pb-1 w-fit max-w-full pointer-events-auto"
    >
      {ROWS.map((row) => (
        <div
          key={row}
          id={labelId[row]}
          data-testid="eta-column-label"
          className="sticky left-0 z-10 w-24 flex items-center px-1.5 text-[10px] font-medium text-fg-secondary bg-surface-raised rounded shadow-1"
        >
          <span className="line-clamp-3 break-words">{labels[row]}</span>
        </div>
      ))}
      {columns.flatMap((column) =>
        ROWS.map((row) => {
          const cell = column[row];
          return (
            <div
              key={`${column.routeId}::${row}`}
              data-testid="eta-cell"
              data-route={column.routeId}
              data-row={row}
              aria-hidden={cell ? undefined : true}
              className="grid"
            >
              {cell && (
                <ETAPill
                  pill={cell}
                  showStop={cell.stop.name !== mainStopNames[row]}
                  describedBy={labelId[row]}
                  onSelect={onSelect}
                />
              )}
            </div>
          );
        }),
      )}
    </div>
  );
}

interface ETARowProps {
  row: Row;
  /** Null → no header and no group semantics (the single-row strip). */
  header: string | null;
  /** Pills leaving from a stop of another name show that name. */
  mainStopName: string;
  pills: PillDeparture[];
  onSelect: (departure: Departure, stop: StopWithLines) => void;
}

function ETARow({ row, header, mainStopName, pills, onSelect }: ETARowProps) {
  const headerId = useId();
  return (
    <div
      data-testid="eta-row"
      data-row={row}
      role={header ? "group" : undefined}
      aria-labelledby={header ? headerId : undefined}
    >
      {header && (
        <div
          id={headerId}
          data-testid="eta-row-header"
          className="inline-block max-w-full truncate mb-1 px-1.5 py-0.5 text-[10px] font-medium text-fg-secondary bg-surface-raised rounded shadow-1 pointer-events-auto"
        >
          {header}
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto scrollbar-hide snap-x snap-mandatory pb-1 w-fit max-w-full pointer-events-auto">
        {pills.map((pill) => (
          <ETAPill
            key={pill.key}
            pill={pill}
            showStop={pill.stop.name !== mainStopName}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

interface ETAPillProps {
  pill: PillDeparture;
  /** Show the stop's name: it is not the one the row is named after. */
  showStop: boolean;
  /** Id of the row label describing the pill (`columns`, which has no row groups). */
  describedBy?: string;
  onSelect: (departure: Departure, stop: StopWithLines) => void;
}

/**
 * One departure as a native `<button>`: the browser turns Enter and Space
 * into its one click, so `onSelect` fires once per activation. `data-pill-key`
 * lets Home put keyboard focus back on the pill a trip sheet was opened from.
 * The `eta-card` test id predates the pills and is kept for the existing
 * page and component tests.
 */
function ETAPill({ pill, showStop, describedBy, onSelect }: ETAPillProps) {
  const { t } = useTranslation();
  const { departure, minutes } = pill;

  const countdown = minutes <= 0
    ? t("popup.due", "Due")
    : `${minutes} ${t("time.min", "min")}`;

  const labelValues = {
    line: departure.routeShortName,
    headsign: departure.headsign,
    stop: pill.stop.name,
    minutes: String(minutes),
  };
  const ariaLabel = minutes <= 0
    ? fill(t("eta.pill_aria_due", "Line {line} toward {headsign}, from {stop}, due now"), labelValues)
    : fill(t("eta.pill_aria", "Line {line} toward {headsign}, from {stop}, in {minutes} min"), labelValues);

  return (
    <button
      type="button"
      data-testid="eta-card"
      data-pill-key={pill.key}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      onClick={() => onSelect(departure, pill.stop)}
      className="flex items-center gap-1.5 px-2 py-1.5 bg-surface-raised rounded-lg shadow-1 shrink-0 min-w-[100px] snap-start text-left"
    >
      <DepartureLineBadge
        data-testid="eta-route-badge"
        label={departure.routeShortName}
        mode={departure.mode}
        subMode={departure.subMode}
        routeColor={departure.routeColor}
        className="text-[10px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap"
      />
      <div className="flex flex-col min-w-0">
        <span className="text-[10px] text-fg-muted truncate">{departure.headsign}</span>
        <span data-testid="eta-countdown" data-countdown className="text-xs font-semibold text-fg">{countdown}</span>
        {showStop && (
          <span data-testid="eta-pill-stop" className="text-[10px] text-fg-muted truncate">{pill.stop.name}</span>
        )}
      </div>
    </button>
  );
}
