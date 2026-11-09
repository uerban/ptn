import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCityDataQuery } from "../../hooks/useCityDataQuery.ts";
import type { BaseEndpoint } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { useMapTapStore } from "../../stores/mapTapStore.ts";
import { useRoutingStore } from "../../stores/routingStore.ts";
import { usePolicy } from "../../stores/privacyStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import type { StopGroupRecord } from "../../db/index.ts";
import { distanceMeters, findStopsInRadius } from "../../services/stopFinder.ts";
import { geocoderRegistry } from "../../services/geocoder/instance.ts";
import { savePlace } from "../../services/saves.ts";
import { reportError } from "../../services/errorReporter.ts";
import { useRegisterMapObstacle } from "../../hooks/useRegisterMapObstacle.ts";

const MAP_TAP_ACTIONS_OBSTACLE_ID = "map-tap-actions";
const MAP_TAP_SAVE_OBSTACLE_ID = "map-tap-save";

/**
 * Action sheet that appears after a long-press drops a pin via `mapTapStore`.
 * Dispatches the reduced `BaseEndpoint` (through `persistMapTap` per the
 * active privacy policy) into `routingStore` — raw sub-meter coords never
 * leave the `mapTapStore` boundary.
 *
 * Both routing actions then navigate to `/search`, which is where the
 * endpoint becomes visible: `SearchPage` hydrates from `routingStore.origin`
 * / `.destination` and clears the slot. Without that navigation the pin would
 * be written to a store the map view has no surface for — the pin appears to
 * do nothing, which is exactly what these actions did before.
 */
export function MapTapActionSheet({ picker }: {
  picker?: { role: "origin" | "destination"; onSelect: (endpoint: BaseEndpoint) => void };
} = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const rawTap = useMapTapStore((s) => s.rawTap);
  const confirmAsEndpoint = useMapTapStore((s) => s.confirmAsEndpoint);
  const reduceToEndpoint = useMapTapStore((s) => s.reduceToEndpoint);
  const clearTap = useMapTapStore((s) => s.clear);
  const setOrigin = useRoutingStore((s) => s.setOrigin);
  const setDestination = useRoutingStore((s) => s.setDestination);
  const policy = usePolicy();
  const walkSpeedMps = useSettingsStore((s) => s.walkSpeedMps);
  const maxWalkSecs = useSettingsStore((s) => s.maxWalkSecs);
  const stopGroups =
    useCityDataQuery(data => data.stopGroups.toArray(), []) ?? [];
  const [mode, setMode] = useState<"actions" | "save">("actions");
  const sheetRef = useRegisterMapObstacle<HTMLDivElement>(
    MAP_TAP_ACTIONS_OBSTACLE_ID,
    rawTap !== null && mode === "actions",
  );

  // Reset to actions mode whenever the underlying tap changes/clears so that
  // the next long-press doesn't drop the user into a stale Save form.
  useEffect(() => {
    if (!rawTap) setMode("actions");
  }, [rawTap]);

  if (!rawTap) return null;

  const maxWalkRadiusMeters = Math.round(walkSpeedMps * maxWalkSecs);
  const reachable = findStopsInRadius(
    { lat: rawTap.lat, lon: rawTap.lon },
    stopGroups.map((g) => ({
      id: g.groupId,
      name: g.name,
      lat: g.lat,
      lon: g.lon,
    })),
    maxWalkRadiusMeters,
    walkSpeedMps,
  );

  if (reachable.length === 0) {
    return (
      <div
        ref={sheetRef}
        role="dialog"
        aria-label={t("mapTap.title", "Dropped pin")}
        className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30
          w-[min(24rem,calc(100vw-1rem))]
          rounded-2xl border border-divider bg-surface-raised
          shadow-lg p-3 flex flex-col gap-2"
      >
        <div className="text-sm font-semibold text-fg">
          {t("mapTap.title", "Dropped pin")}
        </div>
        <div className="text-sm text-fg-muted px-1">
          {t(
            "mapTap.error.noNearbyStops",
            "No transit stops within {radius}m of this point",
          ).replace("{radius}", String(maxWalkRadiusMeters))}
        </div>
        <button
          type="button"
          onClick={() => clearTap()}
          className="w-full text-left px-3 py-2 rounded-lg
            border border-divider hover:bg-surface-overlay
            text-sm text-fg"
        >
          {t("mapTap.error.tryAgain", "Tap somewhere else")}
        </button>
      </div>
    );
  }

  const nearest = pickNearestStopGroup(
    rawTap.lat,
    rawTap.lon,
    policy.mapTapSnapRadiusMeters,
    stopGroups,
  );

  function dispatchEndpoint(
    endpoint: BaseEndpoint,
    role: "origin" | "destination",
  ) {
    if (picker) { picker.onSelect(endpoint); return; }
    if (role === "origin") setOrigin(endpoint);
    else setDestination(endpoint);
    navigate("/search");
  }

  function handleUseTapped(role: "origin" | "destination") {
    const endpoint = confirmAsEndpoint();
    if (!endpoint) return;
    dispatchEndpoint(endpoint, role);
  }

  function handleUseNearest(role: "origin" | "destination") {
    if (!nearest) return;
    const endpoint: BaseEndpoint = {
      kind: "stop",
      stopId: nearest.stopId,
      name: nearest.group.name,
      lat: nearest.group.lat,
      lon: nearest.group.lon,
    };
    clearTap();
    dispatchEndpoint(endpoint, role);
  }

  /**
   * Persists the labelled pin. The tap is reduced but NOT consumed until the
   * write resolves, so a failed save keeps the sheet (and its error state) on
   * screen instead of silently dropping the pin. Rejects on failure — the
   * form owns the user-facing error state.
   */
  async function handleSave(label: string) {
    const endpoint = reduceToEndpoint();
    try {
      // The pin can only be gone here if something cleared the tap underneath
      // the form; report it as a save failure rather than leaving the button
      // stuck on "Saving…".
      if (!endpoint) throw new Error("map tap cleared before save");
      await savePlace({ endpoint, alias: label });
    } catch (err) {
      // Causes vary — crypto OperationError (install key missing), IDB
      // QuotaExceededError. Log for bug reports; the form shows the retry copy.
      reportError(err instanceof Error ? err : new Error(String(err)), {
        context: { surface: "mapTap.savePlace", hasAlias: label !== "" },
      });
      throw err;
    }
    clearTap();
  }

  if (mode === "save") {
    return (
      <SaveLabelForm
        rawTap={rawTap}
        reverseAllowed={
          policy.mapTapPersistedPrecision !== "snap-rounded-100m-no-reverse"
        }
        onCancel={() => setMode("actions")}
        onSubmit={handleSave}
      />
    );
  }

  const tappedLabel = t("mapTap.row.tapped", "Use tapped point");
  const nearestLabel = nearest
    ? t("mapTap.row.nearest", "Use nearest stop: {name}").replace(
        "{name}",
        nearest.group.name,
      )
    : "";

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-label={t("mapTap.title", "Dropped pin")}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30
        w-[min(24rem,calc(100vw-1rem))]
        rounded-2xl border border-divider bg-surface-raised
        shadow-lg p-3 flex flex-col gap-2"
    >
      <div className="text-sm font-semibold text-fg">
        {t("mapTap.title", "Dropped pin")}
      </div>

      <ActionRow
        roleFilter={picker?.role}
        label={nearest ? tappedLabel : undefined}
        originText={t("mapTap.action.origin", "Use as origin")}
        destinationText={t("mapTap.action.destination", "Use as destination")}
        onOrigin={() => handleUseTapped("origin")}
        onDestination={() => handleUseTapped("destination")}
      />

      {nearest && (
        <ActionRow
          roleFilter={picker?.role}
          label={nearestLabel}
          originText={`${nearestLabel} — ${t("mapTap.action.origin", "Use as origin")}`}
          destinationText={`${nearestLabel} — ${t("mapTap.action.destination", "Use as destination")}`}
          onOrigin={() => handleUseNearest("origin")}
          onDestination={() => handleUseNearest("destination")}
        />
      )}

      {!picker && <button
        type="button"
        onClick={() => setMode("save")}
        className="w-full text-left px-3 py-2 rounded-lg
          border border-divider hover:bg-surface-overlay
          text-sm text-fg"
      >
        {t("mapTap.action.save", "Save with label")}
      </button>}

      <button
        type="button"
        onClick={() => clearTap()}
        className="w-full text-left px-3 py-2 rounded-lg
          text-sm text-fg-muted hover:bg-surface-overlay"
      >
        {picker ? t("search.map_another_point", "Choose another point") : t("mapTap.action.cancel", "Cancel")}
      </button>
    </div>
  );
}

interface SaveLabelFormProps {
  rawTap: { lat: number; lon: number };
  reverseAllowed: boolean;
  onCancel: () => void;
  /** Resolves once the place is persisted; rejects so the form can retry. */
  onSubmit: (label: string) => Promise<void>;
}

function SaveLabelForm({
  rawTap,
  reverseAllowed,
  onCancel,
  onSubmit,
}: SaveLabelFormProps) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [labelTouched, setLabelTouched] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">(
    "idle",
  );
  const formRef = useRegisterMapObstacle<HTMLDivElement>(MAP_TAP_SAVE_OBSTACLE_ID);

  // Fire exactly one reverse-geocode per save-form open, and only if the
  // active privacy policy permits it. Paranoid (`snap-rounded-100m-no-reverse`)
  // skips the call entirely — the label is user-entry only.
  useEffect(() => {
    if (!reverseAllowed) return;
    const ctrl = new AbortController();
    let cancelled = false;
    geocoderRegistry
      .reverse({ lat: rawTap.lat, lon: rawTap.lon }, ctrl.signal)
      .then((candidate) => {
        if (cancelled || !candidate) return;
        setLabel((current) => (current === "" ? candidate.label : current));
      })
      .catch(() => {
        // Provider failures are surfaced via GeocoderRegistry status events;
        // the form stays usable with an empty label.
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // rawTap is stable for the lifetime of this form (parent re-renders this
    // component when the tap changes), so depending on its coords is safe.
  }, [reverseAllowed, rawTap.lat, rawTap.lon]);

  return (
    <div
      ref={formRef}
      role="dialog"
      aria-label={t("mapTap.save.title", "Save this location")}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30
        w-[min(24rem,calc(100vw-1rem))]
        rounded-2xl border border-divider bg-surface-raised
        shadow-lg p-3 flex flex-col gap-2"
    >
      <div className="text-sm font-semibold text-fg">
        {t("mapTap.save.title", "Save this location")}
      </div>

      <input
        type="text"
        value={label}
        onChange={(e) => {
          setLabel(e.target.value);
          setLabelTouched(true);
        }}
        placeholder={t("mapTap.save.labelPlaceholder", "Add a label")}
        aria-label={t("mapTap.save.labelPlaceholder", "Add a label")}
        className="w-full px-3 py-2 rounded-lg border border-divider
          bg-surface text-sm text-fg"
      />

      {saveState === "error" && (
        <div role="alert" className="text-sm text-danger px-1">
          {t("mapTap.save.error", "Could not save this location. Try again.")}
        </div>
      )}

      <button
        type="button"
        disabled={label.trim() === "" || saveState === "saving"}
        onClick={() => {
          setSaveState("saving");
          onSubmit(labelTouched ? label : label.trim())
            // On success the parent clears the tap and this form unmounts —
            // no success state to render.
            .catch(() => setSaveState("error"));
        }}
        className="w-full text-left px-3 py-2 rounded-lg
          border border-divider hover:bg-surface-overlay
          text-sm text-fg disabled:opacity-50"
      >
        {saveState === "saving"
          ? t("mapTap.save.saving", "Saving…")
          : t("mapTap.save.confirm", "Save")}
      </button>

      <button
        type="button"
        onClick={onCancel}
        className="w-full text-left px-3 py-2 rounded-lg
          text-sm text-fg-muted hover:bg-surface-overlay"
      >
        {t("mapTap.save.back", "Back")}
      </button>
    </div>
  );
}

interface ActionRowProps {
  roleFilter?: "origin" | "destination";
  label?: string;
  originText: string;
  destinationText: string;
  onOrigin: () => void;
  onDestination: () => void;
}

function ActionRow({
  roleFilter,
  label,
  originText,
  destinationText,
  onOrigin,
  onDestination,
}: ActionRowProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col gap-2 rounded-lg border border-divider p-2"
    >
      {label && (
        <div className="text-xs font-medium text-fg-muted px-1">{label}</div>
      )}
      {roleFilter !== "destination" && <button
        type="button"
        onClick={onOrigin}
        className="w-full text-left px-3 py-2 rounded-lg
          border border-divider hover:bg-surface-overlay
          text-sm text-fg"
      >
        {originText}
      </button>}
      {roleFilter !== "origin" && <button
        type="button"
        onClick={onDestination}
        className="w-full text-left px-3 py-2 rounded-lg
          border border-divider hover:bg-surface-overlay
          text-sm text-fg"
      >
        {destinationText}
      </button>}
    </div>
  );
}

function pickNearestStopGroup(
  lat: number,
  lon: number,
  snapRadiusMeters: number,
  groups: StopGroupRecord[],
): { group: StopGroupRecord; stopId: string; distance: number } | null {
  if (snapRadiusMeters <= 0 || groups.length === 0) return null;

  let nearest: { group: StopGroupRecord; distance: number } | null = null;
  for (const group of groups) {
    const d = distanceMeters(lat, lon, group.lat, group.lon);
    if (d <= snapRadiusMeters && (!nearest || d < nearest.distance)) {
      nearest = { group, distance: d };
    }
  }

  if (!nearest) return null;
  const stopId = nearest.group.stopIds[0];
  if (!stopId) return null;
  return { group: nearest.group, stopId, distance: nearest.distance };
}
