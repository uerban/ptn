/**
 * Arrive-by choice in the Search header: Leave now or Arrive by, the
 * deadline in city time, and Apply. The arrive-by owner is warmed for the
 * likely query (the pair's default deadline) when Search shows the pair's
 * initial Recommended list (H75; the owner has its own worker, H74), and on
 * choosing Arrive by if that list's query was not warmed yet (H72). Apply
 * dispatches the search once. Bundled unless the arrive-by
 * build is off (`arriveByEntry.ts`).
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
import { endpointPairKey, useArriveByUi, type LeaveOption } from "./arriveByUiStore.ts";

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

const segmentClass = (active: boolean): string =>
  `min-h-10 flex-1 px-3 text-sm font-semibold rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
    active ? "bg-accent text-badge-text" : "text-fg hover:bg-surface-overlay"}`;
const chipClass = (active: boolean): string =>
  `min-h-10 shrink-0 px-3 text-sm rounded-full border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
    active ? "bg-accent text-badge-text border-accent font-semibold" : "bg-input-bg text-fg border-divider hover:border-accent"}`;
const LEAVE_OPTIONS: readonly (readonly [LeaveOption, string, string])[] = [
  ["now", "arriveBy.now", "Now"],
  ["in15", "arriveBy.in_15", "In 15 min"],
  ["in30", "arriveBy.in_30", "In 30 min"],
  ["in60", "arriveBy.in_60", "In 1 h"],
  ["custom", "arriveBy.pick_time", "Pick time"],
];
const inputClass = "min-h-12 w-full min-w-0 px-3 text-sm rounded-lg border border-divider bg-input-bg text-fg focus:outline-none focus:ring-2 focus:ring-accent";

export function ArriveByToolbar({ origin, destination, recommended, recommendedInitial, departAt, onDepartAt }: ArriveByToolbarProps) {
  const { t } = useTranslation();
  const cityId = useCityStore((s) => s.activeCity.id);
  const tz = useCityStore((s) => s.activeCity.tz) ?? deviceTz();
  const router = useGtfsDataStore((s) => s.ptRouter);
  const mode = useArriveByUi((s) => s.mode);
  const draftMs = useArriveByUi((s) => s.draftMs);
  const draftVersion = useArriveByUi((s) => s.draftVersion);
  const appliedMs = useArriveByUi((s) => s.appliedMs);
  const leaveOption = useArriveByUi((s) => s.leaveOption);
  const leaveAtMs = useArriveByUi((s) => s.leaveAtMs);

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
    if (mode !== "leave" || !recommendedInitial || recommended.length === 0 || !key) return;
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

  // Tell Search when the rider changes the departure time (not on first render,
  // so returning to Search never clobbers a time that Earlier/Later moved).
  const sentLeaveAt = useRef(leaveAtMs);
  useEffect(() => {
    if (sentLeaveAt.current === leaveAtMs) return;
    sentLeaveAt.current = leaveAtMs;
    onDepartAt?.(leaveAtMs === null ? null : new Date(leaveAtMs));
  }, [leaveAtMs, onDepartAt]);

  const [leaveDate, setLeaveDate] = useState("");
  const [leaveTime, setLeaveTime] = useState("");
  // Earlier/Later move Search's time: show it as the picked time.
  const departAtMs = departAt ? departAt.getTime() : null;
  useEffect(() => {
    if (departAtMs === null || departAtMs === useArriveByUi.getState().leaveAtMs) return;
    sentLeaveAt.current = departAtMs;
    useArriveByUi.getState().setLeaveAt("custom", departAtMs);
  }, [departAtMs]);
  useEffect(() => {
    if (leaveOption !== "custom" || leaveAtMs === null) return;
    const w = toCityWallClock(leaveAtMs, tz);
    setLeaveDate(w.date);
    setLeaveTime(w.time);
  }, [leaveOption, leaveAtMs, tz]);
  const chooseLeaveOption = (option: LeaveOption): void => {
    const ui = useArriveByUi.getState();
    if (option === "now") { ui.setLeaveAt("now", null); return; }
    if (option === "custom") {
      const ms = leaveAtMs ?? Date.now();
      const w = toCityWallClock(ms, tz);
      setLeaveDate(w.date);
      setLeaveTime(w.time);
      ui.setLeaveAt("custom", ms);
      return;
    }
    const minutes = option === "in15" ? 15 : option === "in30" ? 30 : 60;
    ui.setLeaveAt(option, Date.now() + minutes * 60_000);
  };
  const editLeave = (date: string, time: string): void => {
    setLeaveDate(date);
    setLeaveTime(time);
    const ms = fromCityWallClock(date, time, tz);
    if (ms !== null) useArriveByUi.getState().setLeaveAt("custom", ms);
  };

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
      <div className="flex gap-1 p-1 rounded-lg border border-divider bg-input-bg" role="group"
        aria-label={t("arriveBy.when", "When")}>
        <button type="button" aria-pressed={mode === "leave"} className={segmentClass(mode === "leave")}
          onClick={() => useArriveByUi.getState().chooseLeave()}>
          {t("arriveBy.leave", "Leave")}
        </button>
        <button type="button" aria-pressed={mode === "arrive-by"} className={segmentClass(mode === "arrive-by")}
          onClick={chooseArriveBy}>
          {t("arriveBy.arrive_by", "Arrive by")}
        </button>
      </div>
      {mode === "leave" && (
        <div className="space-y-2">
          <div className="flex gap-2 overflow-x-auto" role="group" aria-label={t("arriveBy.leave_at", "Leave at")}>
            {LEAVE_OPTIONS.map(([option, key, fallback]) => (
              <button key={option} type="button" aria-pressed={leaveOption === option} data-testid={`leave-${option}`}
                className={chipClass(leaveOption === option)} onClick={() => chooseLeaveOption(option)}>
                {t(key, fallback)}
              </button>
            ))}
          </div>
          {leaveOption === "custom" && (
            <div className="flex items-center gap-2">
              <label className="flex-[3] min-w-0">
                <span className="sr-only">{t("arriveBy.date", "Date")}</span>
                <input type="date" className={inputClass} value={leaveDate} data-testid="leave-date"
                  onChange={(e) => editLeave(e.target.value, leaveTime)} />
              </label>
              <label className="flex-[2] min-w-0">
                <span className="sr-only">{t("arriveBy.time", "Time")}</span>
                <input type="time" className={inputClass} value={leaveTime} data-testid="leave-time"
                  onChange={(e) => editLeave(leaveDate, e.target.value)} />
              </label>
            </div>
          )}
        </div>
      )}
      {mode === "arrive-by" && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <label className="flex-[3] min-w-0">
              <span className="sr-only">{t("arriveBy.date", "Date")}</span>
              <input type="date" className={inputClass} value={dateText} data-testid="arrive-by-date"
                onChange={(e) => edit(e.target.value, timeText)} />
            </label>
            <label className="flex-[2] min-w-0">
              <span className="sr-only">{t("arriveBy.time", "Time")}</span>
              <input type="time" className={inputClass} value={timeText} data-testid="arrive-by-time"
                onChange={(e) => edit(dateText, e.target.value)} />
            </label>
            <button type="button" disabled={!canApply} onClick={apply} data-testid="arrive-by-apply"
              className="min-h-12 px-4 text-sm font-semibold rounded-lg bg-accent text-badge-text disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {t("arriveBy.apply", "Apply")}
            </button>
          </div>
          {tz !== deviceTz() && (
            <p className="text-xs text-fg-muted">{t("arriveBy.city_time", "Times are in {zone}.").replace("{zone}", tz)}</p>
          )}
        </div>
      )}
    </div>
  );
}
