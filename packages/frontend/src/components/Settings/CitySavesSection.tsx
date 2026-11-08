import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type SavedLocationRecord } from "../../db/index.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useFavoritesStore } from "../../stores/favoritesStore.ts";
import { assignSavedCity, resolveSaves, type ResolvedSave } from "../../services/citySaves.ts";
import { fill } from "../../i18n/fill.ts";
import { useTranslation } from "../../i18n/index.ts";

export function CitySavesSection() {
  const city = useCityStore(s => s.activeCity);
  return <CitySavesRecovery key={city.id} cityId={city.id} cityName={city.name} />;
}

function CitySavesRecovery({cityId, cityName}: {cityId: string; cityName: string}) {
  const {t} = useTranslation();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const favorites = useFavoritesStore(s => s.favorites);
  // Recovery is explicit: ordinary city listing never scans/decrypts foreign
  // or unassigned payloads. No network lookup is used to guess ownership.
  const recovery = useLiveQuery(() => open
    ? Promise.all([db.savedLocations.filter(row => !row.cityId).toArray(), db.savedLocations.toCollection().primaryKeys()])
    : Promise.resolve<[SavedLocationRecord[], string[]]>([[], []]), [open]);
  const rows = recovery?.[0];
  const savedIds = new Set(recovery?.[1]);
  const [resolved, setResolved] = useState<Map<string, ResolvedSave>>(new Map());
  useEffect(() => {
    let cancelled = false;
    if (rows) void resolveSaves(rows).then(values => {
      if (!cancelled) setResolved(new Map(values.map(value => [value.id, value])));
    });
    return () => { cancelled = true; };
  }, [rows]);
  const legacy = open && recovery ? favorites.filter(fav => !fav.cityId && !savedIds.has(fav.id)) : [];
  const assign = async (id: string) => {
    setPending(id);
    setError(false);
    try { await assignSavedCity(id, cityId); }
    catch { setError(true); }
    finally { setPending(null); }
  };
  const action = fill(t("settings.assign_save_city", "Use in {city}"), {city: cityName});
  return <section aria-label={t("settings.city_saved_places", "Saved places for this city")}>
    <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
      {t("settings.city_saved_places", "Saved places for this city")} · {cityName}
    </h2>
    <p className="text-sm text-fg-secondary mb-2">
      {t("settings.city_saves_description", "Home, Work and other saved places belong to the city where you save them.")}
    </p>
    <details className="bg-surface-raised rounded-xl border border-divider p-4" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer">{t("settings.unassigned_saves", "Unassigned saved places")}</summary>
      {open && <div className="space-y-3 mt-3">
        <p className="text-sm text-fg-muted">{t("settings.unassigned_saves_help", "Older saved places may have no city. Choose which ones to use here; the others stay available in this list.")}</p>
        {rows === undefined && <p role="status">{t("common.loading", "Loading…")}</p>}
        {rows?.map(row => {
          const save = resolved.get(row.id);
          return <div key={row.id} className="flex items-center justify-between gap-3">
            <span>{save?.alias || (save?.origin.kind === "stop" ? save.origin.name : save?.origin.kind === "geocoded" || save?.origin.kind === "stopGroup" ? save.origin.label : t("settings.saved_place", "Saved place"))}</span>
            <button type="button" className="text-accent min-h-11" disabled={pending !== null || !save} onClick={() => void assign(row.id)}>{action}</button>
          </div>;
        })}
        {legacy.map(fav => <div key={`legacy-${fav.id}`} className="flex items-center justify-between gap-3">
          <span>{fav.name}</span>
          <button type="button" className="text-accent min-h-11" onClick={() => useFavoritesStore.getState().assignFavoriteCity(fav.id, cityId)}>{action}</button>
        </div>)}
        {rows?.length === 0 && legacy.length === 0 && <p>{t("settings.no_unassigned_saves", "No unassigned saved places.")}</p>}
        {error && <p role="alert">{t("settings.assign_save_error", "Could not assign this saved place. Try again.")}</p>}
      </div>}
    </details>
  </section>;
}
