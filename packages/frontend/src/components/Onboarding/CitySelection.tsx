import { useId, useMemo, useState, type ReactNode } from "react";
import type { CityConfig } from "../../config/cities.ts";
import {
  buildCityList,
  groupsHolding,
  regionNamer,
  type CityNode,
} from "../../setup/cityList.ts";
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
  /** Suggested from the device's time zone when no city is known. */
  readonly suggestedCityId?: string | null;
  readonly busyCityId: string | null;
  readonly text: SetupText;
  /** UI locale, for country names and sorting. */
  readonly locale: string;
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
 * Keyboard-accessible city list. Short catalogs are a plain list of buttons;
 * longer ones add a filter, and long ones group cities by country (and
 * continent) in collapsed disclosures. No map is loaded here.
 */
export function CitySelection(props: CitySelectionProps) {
  const { cities, text, offline, installedCityIds, locale } = props;
  const filterId = useId();
  const locateHelpId = useId();
  const groupIdPrefix = useId();
  const [query, setQuery] = useState("");
  const [nearbyIds, setNearbyIds] = useState<ReadonlySet<string> | null>(null);
  const [locationStatus, setLocationStatus] = useState("");
  const currentCityId = props.preselectedCityId ?? props.suggestedCityId ?? null;
  const suggested = !props.preselectedCityId && !!props.suggestedCityId;

  const regionName = useMemo(() => regionNamer(locale), [locale]);
  const openableCount = useMemo(
    () => cities.filter((city) => isCityOpenable(city, installedCityIds, offline)).length,
    [cities, installedCityIds, offline],
  );
  const view = useMemo(
    () =>
      buildCityList({
        cities,
        openableCount,
        installedCityIds,
        query,
        locale,
        regionName,
        onlyCityIds: nearbyIds,
      }),
    [cities, openableCount, installedCityIds, query, locale, regionName, nearbyIds],
  );
  // The group holding the current city starts open; the rest start collapsed.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(groupsHolding(view.nodes, currentCityId)),
  );
  const toggle = (groupId: string) =>
    setExpanded((open) => {
      const next = new Set(open);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });

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
          setNearbyIds(new Set(matches.map((c) => c.id)));
          setLocationStatus(text("setup.city.locateSeveral"));
        } else {
          setLocationStatus(text("setup.city.locateNone"));
        }
      },
      () => setLocationStatus(text("setup.city.locateUnavailable")),
      { timeout: 10_000 },
    );
  };

  const renderCity = (city: CityConfig, country: string | null): ReactNode => {
    const status = statusFor(city);
    const openable = isCityOpenable(city, installedCityIds, offline);
    const busy = props.busyCityId === city.id;
    const current = city.id === currentCityId;
    const detail = busy
      ? text("setup.city.preparing", { city: city.name })
      : current && suggested
        ? [text("setup.city.suggested"), status].filter(Boolean).join(" · ")
        : status;
    return (
      <li key={city.id}>
        <button
          type="button"
          disabled={!openable || props.busyCityId !== null}
          aria-current={current ? "true" : undefined}
          onClick={() => props.onSelect(city)}
          className="flex w-full min-h-11 flex-col items-start rounded-lg border border-divider bg-surface-raised px-4 py-2 text-left disabled:opacity-60 aria-[current=true]:border-accent"
        >
          <span className="text-base font-medium text-fg">
            {city.name}
            {country && <span className="font-normal text-fg-secondary"> · {country}</span>}
          </span>
          {detail && <span className="text-xs text-fg-muted">{detail}</span>}
        </button>
      </li>
    );
  };

  const renderNode = (node: CityNode): ReactNode => {
    if (node.kind === "city") return renderCity(node.city, node.country);
    const open = expanded.has(node.id);
    const listId = `${groupIdPrefix}-${node.id}`;
    return (
      <li key={node.id}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => toggle(node.id)}
          className="flex w-full min-h-11 items-center justify-between gap-3 rounded-lg border border-divider bg-surface px-4 py-2 text-left text-base font-medium text-fg"
        >
          <span>{node.label}</span>
          <span aria-hidden="true" className="text-fg-muted">
            {open ? "−" : "+"}
          </span>
        </button>
        <ul id={listId} hidden={!open} aria-label={node.label} className="mt-2 flex flex-col gap-2 pl-4">
          {open && node.children.map(renderNode)}
        </ul>
      </li>
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

      {view.showFilter && (
        <>
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
        </>
      )}

      <ul aria-label={text("setup.city.listLabel")} className="flex flex-col gap-2">
        {view.nodes.map(renderNode)}
      </ul>
      {view.nodes.length === 0 && query && (
        <p className="text-sm text-fg-muted">{text("setup.city.noMatches", { query })}</p>
      )}
    </section>
  );
}
