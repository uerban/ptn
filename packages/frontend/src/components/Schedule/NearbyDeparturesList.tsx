import { useCallback, useId, useMemo } from "react";
import type { LatLon, Stop, StopWithLines } from "@pt/shared";
import { COUNTDOWN_INTERVAL_MS } from "@pt/shared/constants";
import { useNearbyDirections } from "../../hooks/useNearbyDirections.ts";
import { useDownloadedStops } from "../../hooks/useDownloadedStops.ts";
import { useServerNow } from "../../hooks/useServerNow.ts";
import { usePresentationText, type PresentationText } from "../../i18n/presentationStrings.ts";
import { bottomStopOf, rowPills, type PillDeparture } from "../../services/nearbyDepartureRows.ts";
import { haversineDistance } from "../../utils/geo.ts";
import { DepartureLineBadge } from "../DepartureLineBadge.tsx";

/** Departures per group, as on the map's strip. */
const MAX_PER_GROUP = 10;

export interface NearbyDeparturesListProps {
  /** The user's position, or the stop they chose; null shows nothing. */
  center: LatLon | null;
  /** Name of the chosen stop when `center` is not the user's position. */
  chosenStopName: string | null;
  /** The departures' stop, to show its full timetable. */
  onSelectStop: (stop: Stop) => void;
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

/**
 * Text mode's nearby departures: the same lines, directions and stops as the
 * map's ETA strip (`useNearbyDirections` + `nearbyDepartureRows`), read from
 * the downloaded stops instead of a map viewport. Each group names its stop
 * and side of the street; each departure names its line, direction and stop.
 * Countdowns refresh silently: nothing here is a live region except the
 * one-time loading status.
 */
export function NearbyDeparturesList({ center, chosenStopName, onSelectStop }: NearbyDeparturesListProps) {
  const text = usePresentationText();
  const headingId = useId();
  const stops = useDownloadedStops();
  const nearby = useNearbyDirections({
    enabled: center !== null,
    position: center,
    visibleStops: stops,
    cityStops: stops,
  });
  const now = useServerNow(COUNTDOWN_INTERVAL_MS, !nearby.loading);

  const nearestStop = nearby.nearestStop;
  const stopsById = useMemo(() => new Map(stops.map((s) => [s.id, s])), [stops]);
  const stopFor = useCallback(
    (id: string): StopWithLines | undefined =>
      id === nearestStop?.id ? nearestStop : stopsById.get(id),
    [nearestStop, stopsById],
  );
  const top = useMemo(
    () => rowPills("top", nearby.sides, nearby.departuresBySide, stopFor, now),
    [nearby.sides, nearby.departuresBySide, stopFor, now],
  );
  const bottom = useMemo(
    () => rowPills("bottom", nearby.sides, nearby.departuresBySide, stopFor, now),
    [nearby.sides, nearby.departuresBySide, stopFor, now],
  );
  const bottomStop = useMemo(() => bottomStopOf(nearby.sides, stopFor), [nearby.sides, stopFor]);

  if (!center || !nearestStop) return null;

  const distance = (stop: StopWithLines) => formatDistance(haversineDistance(center, stop.location));
  const heading = chosenStopName
    ? text("nearby.departuresNear", { stop: chosenStopName })
    : text("nearby.departuresHeading");

  return (
    <section aria-labelledby={headingId} data-testid="nearby-departures" className="px-3 pt-3">
      <h2 id={headingId} className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
        {heading}
      </h2>
      {nearby.loading ? (
        <p role="status" className="text-sm text-fg-muted py-2">{text("nearby.loading")}</p>
      ) : top.length === 0 && bottom.length === 0 ? (
        <p className="text-sm text-fg-muted py-2" data-testid="nearby-departures-empty">{text("nearby.none")}</p>
      ) : (
        <>
          {top.length > 0 && (
            <DepartureGroup
              label={text("nearby.nearestGroup", { stop: nearestStop.name, distance: distance(nearestStop) })}
              row="top"
              pills={top.slice(0, MAX_PER_GROUP)}
              text={text}
              onSelectStop={onSelectStop}
            />
          )}
          {bottom.length > 0 && bottomStop && (
            <DepartureGroup
              label={text("nearby.oppositeGroup", { stop: bottomStop.name, distance: distance(bottomStop) })}
              row="bottom"
              pills={bottom.slice(0, MAX_PER_GROUP)}
              text={text}
              onSelectStop={onSelectStop}
            />
          )}
        </>
      )}
    </section>
  );
}

interface DepartureGroupProps {
  label: string;
  row: "top" | "bottom";
  pills: PillDeparture[];
  text: PresentationText;
  onSelectStop: (stop: Stop) => void;
}

function DepartureGroup({ label, row, pills, text, onSelectStop }: DepartureGroupProps) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} data-testid="nearby-departure-group" data-row={row} className="mb-3">
      <h3 id={labelId} className="text-sm font-medium text-fg mb-1">{label}</h3>
      <ul className="list-none m-0 p-0 flex flex-col gap-1">
        {pills.map((pill) => (
          <li key={pill.key}>
            <DepartureRow pill={pill} text={text} onSelectStop={onSelectStop} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DepartureRow({ pill, text, onSelectStop }: { pill: PillDeparture; text: PresentationText; onSelectStop: (stop: Stop) => void }) {
  const { departure, minutes, stop } = pill;
  const when = minutes <= 0 ? text("nearby.due") : text("nearby.inMinutes", { minutes: String(minutes) });
  const status = departure.predictedTime ? text("nearby.live") : text("nearby.scheduled");
  const label = `${text("nearby.departureLabel", {
    line: departure.routeShortName,
    headsign: departure.headsign,
    stop: stop.name,
  })}, ${when}, ${status}`;
  return (
    <button
      type="button"
      data-testid="nearby-departure"
      data-status={departure.predictedTime ? "live" : "scheduled"}
      aria-label={label}
      onClick={() => onSelectStop({ id: stop.id, name: stop.name, location: stop.location })}
      className="w-full flex items-center gap-2 px-3 py-2 min-h-11 rounded-lg bg-surface-overlay border border-divider text-left hover:bg-surface-raised"
    >
      <DepartureLineBadge
        label={departure.routeShortName}
        mode={departure.mode}
        subMode={departure.subMode}
        routeColor={departure.routeColor}
        className="text-xs font-bold px-1.5 py-0.5 rounded whitespace-nowrap"
      />
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-fg truncate">{departure.headsign}</span>
        <span className="block text-xs text-fg-muted truncate">{stop.name}</span>
      </span>
      <span className="flex flex-col items-end shrink-0">
        <span className="text-sm font-semibold text-fg">{when}</span>
        <span className={`text-xs ${departure.predictedTime ? "text-success" : "text-fg-muted"}`}>{status}</span>
      </span>
    </button>
  );
}
