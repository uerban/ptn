import { useId, useMemo, useState } from "react";
import type { CityConfig } from "../../config/cities.ts";
import { isCityOpenable } from "../../setup/startupPlan.ts";
import type { SetupText } from "../../setup/setupStrings.ts";

export type CatalogStatus = "fresh" | "cached" | "device-only" | "failed";

export interface CitySelectionProps {
  readonly cities: readonly CityConfig[];
  readonly downloadedSizes: ReadonlyMap<string, number>;
  readonly installedCityIds: ReadonlySet<string>;
  readonly offline: boolean;
  readonly catalogStatus: CatalogStatus;
  readonly preselectedCityId: string | null;
  readonly busyCityId: string | null;
  readonly text: SetupText;
  readonly formatSize: (bytes: number) => string;
  readonly onSelect: (city: CityConfig) => void;
  readonly onRetry: () => void;
}

function citiesAt(cities: readonly CityConfig[], lat: number, lon: number): CityConfig[] {
  return cities.filter(
    (c) =>
      lat >= c.bbox.minLat && lat <= c.bbox.maxLat && lon >= c.bbox.minLon && lon <= c.bbox.maxLon,
  );
}

/**
 * Searchable, keyboard-accessible city list: a plain filter input above a
 * list of buttons. No map is loaded here.
 */
export function CitySelection(props: CitySelectionProps) {
  const { cities, text, offline, installedCityIds } = props;
  const filterId = useId();
  const locateHelpId = useId();
  const [query, setQuery] = useState("");
  const [nearbyIds, setNearbyIds] = useState<readonly string[] | null>(null);
  const [locationStatus, setLocationStatus] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return cities.filter(
      (city) =>
        (!needle || city.name.toLocaleLowerCase().includes(needle)) &&
        (!nearbyIds || nearbyIds.includes(city.id)),
    );
  }, [cities, query, nearbyIds]);

  const statusFor = (city: CityConfig): string | null => {
    const size = props.downloadedSizes.get(city.id);
    if (size !== undefined) {
      return size > 0
        ? text("setup.city.downloadedSize", { size: props.formatSize(size) })
        : text("setup.city.downloaded");
    }
    if (installedCityIds.has(city.id)) return text("setup.city.cached");
    if (city.available === false) return text("setup.city.unavailable");
    if (offline) return text("setup.city.needsConnection");
    return null;
  };

  const locate = () => {
    if (!navigator.geolocation) {
      setLocationStatus(text("setup.city.locateUnavailable"));
      return;
    }
    setLocationStatus(text("setup.city.locating"));
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const matches = citiesAt(cities, position.coords.latitude, position.coords.longitude);
        const openable = matches.filter((c) => isCityOpenable(c, installedCityIds, offline));
        if (matches.length === 1 && openable.length === 1) {
          setLocationStatus("");
          props.onSelect(openable[0]);
        } else if (matches.length) {
          setNearbyIds(matches.map((c) => c.id));
          setLocationStatus(text("setup.city.locateSeveral"));
        } else {
          setLocationStatus(text("setup.city.locateNone"));
        }
      },
      () => setLocationStatus(text("setup.city.locateUnavailable")),
      { timeout: 10_000 },
    );
  };

  const notice =
    props.catalogStatus === "cached"
      ? text("setup.city.catalogCached")
      : props.catalogStatus === "device-only"
        ? text("setup.city.catalogDeviceOnly")
        : offline
          ? text("setup.city.offline")
          : null;

  if (props.catalogStatus === "failed") {
    return (
      <section aria-labelledby="setup-city-heading" className="flex flex-col gap-3">
        <h1 tabIndex={-1} id="setup-city-heading" className="text-2xl font-semibold text-fg">
          {text("setup.city.heading")}
        </h1>
        <p role="alert" className="text-sm text-fg">
          {text("setup.city.catalogFailed")} {text("setup.city.catalogFailedNext")}
        </p>
        <button
          type="button"
          onClick={props.onRetry}
          className="self-start min-h-11 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          {text("setup.city.retry")}
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby="setup-city-heading" className="flex flex-col gap-3">
      <h1 tabIndex={-1} id="setup-city-heading" className="text-2xl font-semibold text-fg">
        {text("setup.city.heading")}
      </h1>
      <p className="text-sm text-fg-secondary">{text("setup.city.intro")}</p>
      {notice && (
        <p role="status" className="text-sm text-fg">
          {notice}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={locate}
          aria-describedby={locateHelpId}
          className="self-start min-h-11 rounded-lg border border-divider bg-surface-raised px-4 py-2 text-sm font-medium text-fg"
        >
          {text("setup.city.locate")}
        </button>
        <p id={locateHelpId} className="text-xs text-fg-muted">
          {text("setup.city.locateExplain")}
        </p>
        <p role="status" className="text-sm text-fg">
          {locationStatus}
        </p>
      </div>

      <label htmlFor={filterId} className="text-sm font-medium text-fg">
        {text("setup.city.filterLabel")}
      </label>
      <input
        id={filterId}
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setNearbyIds(null);
        }}
        autoComplete="off"
        className="min-h-11 rounded-lg border border-divider bg-surface-raised px-3 text-base text-fg"
      />

      <ul aria-label={text("setup.city.listLabel")} className="flex flex-col gap-2">
        {visible.map((city) => {
          const status = statusFor(city);
          const openable = isCityOpenable(city, installedCityIds, offline);
          const busy = props.busyCityId === city.id;
          return (
            <li key={city.id}>
              <button
                type="button"
                disabled={!openable || props.busyCityId !== null}
                aria-current={city.id === props.preselectedCityId ? "true" : undefined}
                onClick={() => props.onSelect(city)}
                className="flex w-full min-h-11 flex-col items-start rounded-lg border border-divider bg-surface-raised px-4 py-2 text-left disabled:opacity-60 aria-[current=true]:border-accent"
              >
                <span className="text-base font-medium text-fg">{city.name}</span>
                {(status || busy) && (
                  <span className="text-xs text-fg-muted">
                    {busy ? text("setup.city.preparing", { city: city.name }) : status}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {visible.length === 0 && query && (
        <p className="text-sm text-fg-muted">{text("setup.city.noMatches", { query })}</p>
      )}
    </section>
  );
}
