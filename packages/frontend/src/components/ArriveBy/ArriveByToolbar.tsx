/**
 * Opt-in Arrive-by choice in the Search header: Leave now or Arrive by, the
 * deadline in city time, and Apply. The arrive-by owner is warmed for the
 * likely query (the pair's default deadline) when Search shows the pair's
 * initial Recommended list (H75; the owner has its own worker, H74), and on
 * choosing Arrive by if that list's query was not warmed yet (H72). Apply
 * dispatches the search once. Bundled only in a `PTN_ARRIVE_BY_EXPERIMENT=1`
 * build (`arriveByExperiment.ts`).
 */
import { useEffect, useRef, useState } from "react";
import type { BaseEndpoint, Itinerary } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import type { PtRouterHandle } from "../../services/raptorWasm.ts";
import { defaultDeadlineMs, fromCityWallClock, toCityWallClock } from "./arriveByDeadline.ts";
import { ARRIVE_BY_MARKS, markArriveBy, type ArriveByCaller } from "./arriveByMarks.ts";
import { prepareArriveBy } from "./arriveByQuery.ts";
import type { ArriveByToolbarProps } from "./arriveByTypes.ts";
import { endpointPairKey, useArriveByUi } from "./arriveByUiStore.ts";

const deviceTz = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

type WarmTrigger = Exclude<ArriveByCaller, "apply">;

/** One warm-up request on the likely query; its outcome is a mark only. */
async function warmArriveBy(origin: BaseEndpoint, destination: BaseEndpoint, deadlineMs: number,
  router: PtRouterHandle, trigger: WarmTrigger): Promise<void> {
  const channel = router.arriveBy;
  if (!channel) return;
  try {
    const prepared = await prepareArriveBy(origin, destination, deadlineMs, router, trigger);
    if (prepared.kind !== "ready") { markArriveBy(ARRIVE_BY_MARKS.warm, { result: prepared.kind, trigger }); return; }
    const result = await channel.warm(prepared.prepared.input);
    markArriveBy(ARRIVE_BY_MARKS.warm, { result, deadlineMs, trigger });
  } catch (err) {
    markArriveBy(ARRIVE_BY_MARKS.warm, { result: "error", trigger, message: err instanceof Error ? err.message : String(err) });
  }
}

const choiceClass = (active: boolean): string =>
  `min-h-12 flex-1 px-3 text-sm font-semibold rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
    active ? "bg-accent text-badge-text border-accent" : "bg-input-bg text-fg border-divider hover:border-accent"}`;
const inputClass = "min-h-12 px-3 text-sm rounded-lg border border-divider bg-input-bg text-fg focus:outline-none focus:ring-2 focus:ring-accent";

export function ArriveByToolbar({ origin, destination, recommended, recommendedInitial }: ArriveByToolbarProps) {
  const { t } = useTranslation();
  const cityId = useCityStore((s) => s.activeCity.id);
  const tz = useCityStore((s) => s.activeCity.tz) ?? deviceTz();
  const router = useGtfsDataStore((s) => s.ptRouter);
  const mode = useArriveByUi((s) => s.mode);
  const draftMs = useArriveByUi((s) => s.draftMs);
  const draftVersion = useArriveByUi((s) => s.draftVersion);
  const appliedMs = useArriveByUi((s) => s.appliedMs);

  useEffect(() => { useArriveByUi.getState().syncCity(cityId); }, [cityId]);

  // The default comes from the initial Recommended page of the endpoints it
  // was planned for: a new list is a new result, so key on the list itself.
  const pairKey = origin && destination ? endpointPairKey(origin, destination) : null;
  const pairRef = useRef(pairKey);
  pairRef.current = pairKey;
  useEffect(() => {
    const key = pairRef.current;
    if (key && recommendedInitial && recommended.length > 0) {
      useArriveByUi.getState().rememberDefault(key, defaultDeadlineMs(recommended, Date.now(), tz));
    }
  }, [recommended, recommendedInitial, tz]);

  // The list whose query was last warmed (H75), and the list shown now.
  const warmedList = useRef<{ list: readonly Itinerary[]; deadline: number } | null>(null);
  const shownList = useRef(recommended);
  shownList.current = recommended;

  // H75: in Leave now, each initial Recommended list warms the likely
  // Arrive-by query: this pair's default deadline with the settings the list
  // was planned with. The owner has its own worker (H74), so this never
  // delays a normal search.
  useEffect(() => {
    const key = pairRef.current;
    if (mode !== "leave-now" || !recommendedInitial || recommended.length === 0 || !key) return;
    if (!origin || !destination || !router?.arriveBy) return;
    const deadline = useArriveByUi.getState().defaults[key];
    if (deadline === undefined) return;
    const warmed = warmedList.current;
    if (warmed && warmed.list === recommended && warmed.deadline === deadline) return;
    warmedList.current = { list: recommended, deadline };
    void warmArriveBy(origin, destination, deadline, router, "results");
  }, [mode, recommended, recommendedInitial, origin, destination, router]);

  // H72: warm on arrive-by intent (the choice, or that mode restored) once
  // the endpoints are known, unless the shown list's query is already warm.
  // Editing the deadline posts nothing more.
  useEffect(() => {
    if (mode !== "arrive-by" || appliedMs !== null || !origin || !destination || !router?.arriveBy) return;
    const deadline = useArriveByUi.getState().draftMs;
    if (deadline === null) return;
    const warmed = warmedList.current;
    if (warmed && warmed.list === shownList.current && warmed.deadline === deadline) return;
    void warmArriveBy(origin, destination, deadline, router, "choice");
  }, [mode, appliedMs, origin, destination, router]);

  const [dateText, setDateText] = useState("");
  const [timeText, setTimeText] = useState("");
  useEffect(() => {
    const ms = useArriveByUi.getState().draftMs;
    if (ms === null) return;
    const w = toCityWallClock(ms, tz);
    setDateText(w.date);
    setTimeText(w.time);
  }, [draftVersion, tz]);

  const chooseArriveBy = (): void => {
    const s = useArriveByUi.getState();
    const fallback = defaultDeadlineMs([], Date.now(), tz);
    s.chooseArriveBy((pairKey ? s.defaults[pairKey] : undefined) ?? fallback);
    markArriveBy(ARRIVE_BY_MARKS.choose, { deadlineMs: useArriveByUi.getState().draftMs });
  };
  const edit = (date: string, time: string): void => {
    setDateText(date);
    setTimeText(time);
    useArriveByUi.getState().editDraft(fromCityWallClock(date, time, tz));
  };
  const apply = (): void => {
    markArriveBy(ARRIVE_BY_MARKS.apply, { deadlineMs: draftMs });
    useArriveByUi.getState().apply();
  };
  const canApply = mode === "arrive-by" && draftMs !== null && draftMs !== appliedMs;

  return (
    <div className="space-y-2" data-testid="arrive-by-toolbar">
      <div className="flex gap-2" role="group" aria-label={t("arriveBy.when", "When")}>
        <button type="button" aria-pressed={mode === "leave-now"} className={choiceClass(mode === "leave-now")}
          onClick={() => useArriveByUi.getState().chooseLeaveNow()}>
          {t("arriveBy.leave_now", "Leave now")}
        </button>
        <button type="button" aria-pressed={mode === "arrive-by"} className={choiceClass(mode === "arrive-by")}
          onClick={chooseArriveBy}>
          {t("arriveBy.arrive_by", "Arrive by")}
        </button>
      </div>
      {mode === "arrive-by" && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            {t("arriveBy.date", "Date")}
            <input type="date" className={inputClass} value={dateText} data-testid="arrive-by-date"
              onChange={(e) => edit(e.target.value, timeText)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            {t("arriveBy.time", "Time")}
            <input type="time" className={inputClass} value={timeText} data-testid="arrive-by-time"
              onChange={(e) => edit(dateText, e.target.value)} />
          </label>
          <button type="button" disabled={!canApply} onClick={apply} data-testid="arrive-by-apply"
            className="min-h-12 px-4 text-sm font-semibold rounded-lg bg-accent text-badge-text disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {t("arriveBy.apply", "Apply")}
          </button>
          {tz !== deviceTz() && (
            <p className="w-full text-xs text-fg-muted">{t("arriveBy.city_time", "Times are in {zone}.").replace("{zone}", tz)}</p>
          )}
        </div>
      )}
    </div>
  );
}
