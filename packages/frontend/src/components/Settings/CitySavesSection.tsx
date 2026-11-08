import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../db/index.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useFavoritesStore } from "../../stores/favoritesStore.ts";
import { assignSavedCity, listUnassignedSaves, type ResolvedSave } from "../../services/citySaves.ts";
import { listSaves } from "../../services/saves.ts";
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
  // Recovery is explicit: ordinary city listing never shows unassigned saves.
  // No network lookup is used to guess ownership. The live query only signals
  // changes; ownership is sealed, so saves are decrypted and then filtered.
  const changed = useLiveQuery(() => open ? db.savedLocations.count() : Promise.resolve(0), [open]);
  const [recovery, setRecovery] = useState<{rows: ResolvedSave[]; savedIds: Set<string>} | undefined>();
  useEffect(() => {
    let cancelled = false;
    if (!open) { setRecovery(undefined); return; }
    void Promise.all([listUnassignedSaves(), listSaves()]).then(([rows, all]) => {
      if (!cancelled) setRecovery({rows, savedIds: new Set(all.map(save => save.id))});
    }, () => { if (!cancelled) setRecovery({rows: [], savedIds: new Set()}); });
    return () => { cancelled = true; };
  }, [open, changed, pending]);
  const rows = recovery?.rows;
  const savedIds = recovery?.savedIds ?? new Set<string>();
  const resolved = new Map(rows?.map(save => [save.id, save]));
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
