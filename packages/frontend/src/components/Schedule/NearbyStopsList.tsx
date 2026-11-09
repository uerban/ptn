import { useState, useMemo, useId } from "react";
import type { StopGroupRecord } from "../../db/index.ts";
import type { LatLon } from "@pt/shared";
import { haversineDistance } from "../../utils/geo.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { resolveDirections } from "../../services/directionResolver.ts";
import { StopCard } from "./StopCard.tsx";
import { ExpandableStopGroup } from "./ExpandableStopGroup.tsx";
import { useTranslation } from "../../i18n/index.ts";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import { useGeolocation } from "../../hooks/useGeolocation.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useNearbyAnchor, useNearbyAnchorStore } from "../../stores/nearbyAnchorStore.ts";

// Based on Gallotti's 8-bit cognitive limit
const MAX_VISIBLE_STOPS = 6;

const EMPTY_STOP_NAMES = new Map<string, string>();

export interface NearbyStopsListProps {
  groups: StopGroupRecord[];
  userLocation: LatLon | null;
  onStopSelect: (group: StopGroupRecord) => void;
  loading?: boolean;
}

interface SortedGroup {
  group: StopGroupRecord;
  /** Null without a centre: no distance is claimed. */
  distanceMeters: number | null;
}

export function NearbyStopsList({
  groups,
  userLocation,
  onStopSelect,
  loading = false,
}: NearbyStopsListProps) {
  const { t } = useTranslation();
  const text = usePresentationText();
  const filterId = useId();
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");

  const raptorIndex = useGtfsDataStore((s) => s.raptorIndex);
  const stopNames = useGtfsDataStore((s) => s.stopNames) ?? EMPTY_STOP_NAMES;
  const gpsMode = useSettingsStore((s) => s.gpsMode);
  const cityId = useCityStore((s) => s.activeCity.id);
  const { error: locationError, requestLocation } = useGeolocation();
  // Without a position, a stop the user chose stands in as the centre.
  const anchor = useNearbyAnchor();
  const center: LatLon | null = userLocation ?? anchor?.location ?? null;

  // All hooks must be called unconditionally (React Rules of Hooks).
  // Nearest first from the centre; without one, by name, filtered by the
  // user's query — never sorted as if every stop were "near".
  const sorted: SortedGroup[] = useMemo(() => {
    if (!center) {
      const needle = query.trim().toLocaleLowerCase();
      return groups
        .filter((group) => !needle || group.name.toLocaleLowerCase().includes(needle))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((group) => ({ group, distanceMeters: null }));
    }
    const result = groups.map((group) => ({
      group,
      distanceMeters: haversineDistance(center, { lat: group.lat, lon: group.lon }),
    }));
    result.sort((a, b) => a.distanceMeters - b.distanceMeters);
    return result;
  }, [groups, center, query]);

  // Choosing a stop without a position makes it the centre of "nearby".
  const selectStop = (group: StopGroupRecord) => {
    if (!userLocation && !anchor) {
      useNearbyAnchorStore.getState().setAnchor({
        cityId,
        stopId: group.stopIds[0] ?? group.groupId,
        name: group.name,
        location: { lat: group.lat, lon: group.lon },
      });
    }
    onStopSelect(group);
  };

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={t("nearby.locating", "Locating you")}
        className="flex flex-col items-center justify-center py-10 gap-2 text-fg-muted"
        data-testid="nearby-loading"
      >
        <svg
          className="w-6 h-6 animate-spin"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v8H4z"
          />
        </svg>
        <span className="text-sm">{t("nearby.locating", "Locating you…")}</span>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-10 gap-2 text-fg-muted"
        data-testid="nearby-empty"
      >
        <span className="text-sm">{t("nearby.no_stops", "No stops found nearby")}</span>
      </div>
    );
  }

  const visible = showAll ? sorted : sorted.slice(0, MAX_VISIBLE_STOPS);
  const hasMore = sorted.length > MAX_VISIBLE_STOPS;

  // Codebase uses simple {token} placeholders with .replace() (no i18next
  // runtime). The fallback is "{count} nearby stops"; legacy callers in
  // existing tests still match because both the count and "Nearby stops"
  // appear in the rendered string. Only a real centre earns "nearby".
  const listAriaLabel = userLocation
    ? t("schedule.stop_list", "{count} nearby stops").replace("{count}", String(visible.length))
    : anchor
      ? text("nearby.stopsNear", { stop: anchor.name })
      : text("nearby.allStops", { count: String(visible.length) });

  const chooser = !userLocation && (
    <div className="px-3 pt-3 pb-2 flex flex-col gap-2" data-testid="nearby-chooser">
      {anchor ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-fg">{text("nearby.stopsNear", { stop: anchor.name })}</p>
          <button
            type="button"
            data-testid="nearby-change-area"
            onClick={() => {
              useNearbyAnchorStore.getState().clear();
              setShowAll(false);
            }}
            className="min-h-11 px-3 rounded-lg border border-divider text-sm text-fg shrink-0"
          >
            {text("nearby.changeArea")}
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm text-fg" data-testid="nearby-no-location">
            {locationError ? text("nearby.locationUnavailable") : text("nearby.noLocation")}
          </p>
          {gpsMode !== "disabled" && (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                data-testid="nearby-use-location"
                onClick={requestLocation}
                aria-describedby={`${filterId}-locate`}
                className="self-start min-h-11 px-3 rounded-lg border border-divider text-sm text-fg"
              >
                {text("nearby.useLocation")}
              </button>
              <p id={`${filterId}-locate`} className="text-xs text-fg-muted">{text("nearby.locateExplain")}</p>
            </div>
          )}
          <label htmlFor={filterId} className="text-sm font-medium text-fg">
            {text("nearby.filterLabel")}
          </label>
          <input
            id={filterId}
            type="search"
            data-testid="nearby-stop-filter"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShowAll(false);
            }}
            className="min-h-11 px-3 rounded-lg border border-divider bg-surface text-fg"
          />
          {query.trim() && sorted.length === 0 && (
            <p className="text-sm text-fg-muted">{text("nearby.noMatches", { query: query.trim() })}</p>
          )}
        </>
      )}
    </div>
  );

  return (
    <>
    {chooser}
    <ul
      role="list"
      aria-label={listAriaLabel}
      data-testid="nearby-stops-list"
      className="list-none m-0 p-0"
    >
      {visible.map(({ group, distanceMeters }) => {
        // Resolve line labels from RAPTOR index
        const lineLabels: string[] = [];
        const lineColors = new Map<string, string>();
        const platformCodes = new Map<string, string>();

        if (raptorIndex) {
          const seenLabels = new Set<string>();
          for (const stopId of group.stopIds) {
            const routeIndices = raptorIndex.routesAtStop.get(stopId);
            if (routeIndices) {
              for (const idx of routeIndices) {
                const route = raptorIndex.routes[idx];
                if (route && !seenLabels.has(route.shortName)) {
                  seenLabels.add(route.shortName);
                  lineLabels.push(route.shortName);
                  if (route.color) {
                    lineColors.set(route.shortName, route.color);
                  }
                }
              }
            }
          }
        }

        // Resolve direction labels for the first (primary) stop in the group
        const primaryStopId = group.stopIds[0] ?? group.groupId;
        const directionLabels = raptorIndex
          ? resolveDirections(primaryStopId, raptorIndex, stopNames)
          : [];

        if (group.type === "name_numbered") {
          return (
            <li key={group.groupId}>
              <ExpandableStopGroup
                group={group}
                distanceMeters={distanceMeters}
                lineLabels={lineLabels}
                lineColors={lineColors}
                directionLabels={directionLabels}
                platformCodes={platformCodes}
                stopNames={stopNames}
                onStopSelect={(stopId) => {
                  // Find stop by stopId and call onStopSelect with a synthetic group
                  const syntheticGroup: StopGroupRecord = {
                    ...group,
                    stopIds: [stopId],
                  };
                  selectStop(syntheticGroup);
                }}
              />
            </li>
          );
        }

        return (
          <li key={group.groupId}>
            <StopCard
              group={group}
              distanceMeters={distanceMeters}
              lineLabels={lineLabels}
              lineColors={lineColors}
              directionLabels={directionLabels}
              platformCodes={platformCodes}
              onSelect={() => selectStop(group)}
            />
          </li>
        );
      })}

      {hasMore && !showAll && (
        <li className="mx-2 mt-2 mb-3 list-none">
          <button
            type="button"
            data-testid="show-more-btn"
            className="w-full py-2 text-sm text-fg-muted bg-surface-raised border border-divider rounded-lg hover:bg-surface-overlay transition-colors"
            onClick={() => setShowAll(true)}
          >
            {t("nearby.show_more", "Show more")} ({sorted.length - MAX_VISIBLE_STOPS})
          </button>
        </li>
      )}
    </ul>
    </>
  );
}
