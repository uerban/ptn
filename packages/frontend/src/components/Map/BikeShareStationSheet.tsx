import { useTranslation } from "../../i18n/index.ts";
import { pluralize } from "../../i18n/plurals.ts";
import { useBikeShareStore } from "../../stores/bikeShareStore.ts";
import { useRegisterMapObstacle } from "../../hooks/useRegisterMapObstacle.ts";

const BIKE_STATION_SHEET_OBSTACLE_ID = "bike-station-sheet";

/**
 * Bottom sheet with the tapped bike station's details, driven by
 * `bikeShareStore.selectedStationId` (set by `BikeShareLayer`'s circle-layer
 * click handler). Layout mirrors `MapTapActionSheet`.
 *
 * Content rules:
 * - null counts render as UNKNOWN ("Availability unknown"), never as `0`;
 * - the "not renting" flag needs status evidence — with unknown status
 *   (`bikesAvailable`/`docksAvailable` both null) it is NOT shown, because
 *   the conservative merge defaults `isRenting:false` there;
 * - operator attribution names the first configured system: the store's
 *   runtime drives exactly that one (single-operator scope, see
 *   `bikeShareStore`), so every rendered station is its — attribution is
 *   never a guess even when more systems are configured.
 */
export function BikeShareStationSheet() {
  const { t, locale, formattingLocale } = useTranslation();
  const selectedStationId = useBikeShareStore((s) => s.selectedStationId);
  const stations = useBikeShareStore((s) => s.stations);
  const systems = useBikeShareStore((s) => s.systems);
  const clearStationSelection = useBikeShareStore((s) => s.clearStationSelection);

  // A stale id (station dropped by a refresh mid-selection) means no sheet.
  const station =
    selectedStationId === null
      ? null
      : (stations.find((s) => s.stationId === selectedStationId) ?? null);
  const sheetRef = useRegisterMapObstacle<HTMLDivElement>(
    BIKE_STATION_SHEET_OBSTACLE_ID,
    station !== null,
  );
  if (!station) return null;

  const statusKnown =
    station.bikesAvailable !== null || station.docksAvailable !== null;

  // Counts run through `pluralize` so ru/uk/be/pl/lt get their few/many forms;
  // a bare `n === 1` split renders "5 велосипед" in every Slavic locale.
  const availabilityParts: string[] = [];
  if (station.bikesAvailable !== null) {
    availabilityParts.push(
      pluralize(
        locale,
        station.bikesAvailable,
        t("bikeShare.sheet.bikes_one", "{n} bike"),
        t("bikeShare.sheet.bikes_few", "{n} bikes"),
        t("bikeShare.sheet.bikes_many", "{n} bikes"),
      ).replace("{n}", String(station.bikesAvailable)),
    );
  }
  if (station.docksAvailable !== null) {
    availabilityParts.push(
      pluralize(
        locale,
        station.docksAvailable,
        t("bikeShare.sheet.docksFree_one", "{n} dock free"),
        t("bikeShare.sheet.docksFree_few", "{n} docks free"),
        t("bikeShare.sheet.docksFree_many", "{n} docks free"),
      ).replace("{n}", String(station.docksAvailable)),
    );
  }
  const availability =
    availabilityParts.length > 0
      ? availabilityParts.join(" · ")
      : t("bikeShare.sheet.unknown", "Availability unknown");

  const operator = systems[0]?.name ?? null;

  const updated =
    station.lastReported !== null
      ? t("bikeShare.sheet.updated", "Updated {time}").replace(
          "{time}",
          new Date(station.lastReported * 1000).toLocaleTimeString(
            formattingLocale,
            { hour: "2-digit", minute: "2-digit" },
          ),
        )
      : null;

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-label={station.name}
      data-testid="bike-station-sheet"
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30
        w-[min(24rem,calc(100vw-1rem))]
        rounded-2xl border border-divider bg-surface-raised
        shadow-lg p-3 flex flex-col gap-2"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-fg truncate">
            {station.name}
          </div>
          {station.address && (
            <div className="text-xs text-fg-muted truncate">
              {station.address}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => clearStationSelection()}
          aria-label={t("bikeShare.sheet.close", "Close")}
          className="shrink-0 px-2 py-1 rounded-lg
            text-sm text-fg-muted hover:bg-surface-overlay"
        >
          ✕
        </button>
      </div>

      <div className="text-sm text-fg">{availability}</div>

      {statusKnown && !station.isRenting && (
        <div className="text-xs font-medium text-warning">
          {t("bikeShare.sheet.notRenting", "Not renting")}
        </div>
      )}

      {(operator !== null || updated !== null) && (
        <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
          {operator !== null && (
            <span data-testid="bike-station-operator" className="truncate">
              {operator}
            </span>
          )}
          {updated !== null && <span className="shrink-0">{updated}</span>}
        </div>
      )}
    </div>
  );
}
