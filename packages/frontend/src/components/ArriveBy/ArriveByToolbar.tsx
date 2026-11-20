/**
 * Time choice in the Search header. Collapsed it is one button that says
 * what the results are planned for ("Leave: Now", "Arrive by 10:13") and
 * shares its row with Search's sort chip, so the header stays short.
 * Opened it shows Leave or Arrive by, the
 * deadline in city time, and Apply. The arrive-by owner is warmed for the
 * likely query (the pair's default deadline) when Search shows the pair's
 * initial Recommended list (H75; the owner has its own worker, H74), and on
 * choosing Arrive by if that list's query was not warmed yet (H72). Apply
 * dispatches the search once. Bundled unless the arrive-by
 * build is off (`arriveByEntry.ts`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { searchChipClass } from "../Search/searchChip.ts";
import { BottomSheet } from "../Layout/BottomSheet.tsx";

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
  `min-h-11 min-w-0 flex-1 px-[min(0.75rem,8px)] text-[min(0.875rem,24px)] leading-tight font-semibold rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
    active ? "bg-accent text-badge-text" : "text-fg hover:bg-surface-overlay"}`;
const chipClass = (active: boolean): string => searchChipClass(active ? "selected" : "idle");
const LEAVE_OPTIONS: readonly (readonly [LeaveOption, string, string])[] = [
  ["now", "arriveBy.now", "Now"],
  ["in15", "arriveBy.in_15", "In 15 min"],
  ["in30", "arriveBy.in_30", "In 30 min"],
  ["in60", "arriveBy.in_60", "In 1 h"],
  ["custom", "arriveBy.pick_time", "Pick time"],
];
const inputClass = "min-h-12 w-full min-w-0 px-3 text-sm rounded-lg border border-divider bg-input-bg text-fg focus:outline-none focus:ring-2 focus:ring-accent";

const summaryClass = searchChipClass("idle");

export function ArriveByToolbar({ origin, destination, recommended, recommendedInitial, departAt, onDepartAt, sort, arriveBySort, filters }: ArriveByToolbarProps) {
  const { t, locale } = useTranslation();
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
  // The "When" sheet opens only when asked for. An Arrive-by choice that was
  // never applied (restored on return to Search) falls back to Leave, so the
  // chip says what the results show; the edited deadline is kept.
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  // What the polite status says after the sheet closes with a change.
  const [announce, setAnnounce] = useState<"summary" | "fallback" | null>(null);
  useEffect(() => {
    const ui = useArriveByUi.getState();
    if (ui.mode === "arrive-by" && ui.appliedMs === null) ui.chooseLeave();
  }, []);
  useEffect(() => {
    if (announce !== "fallback") return;
    const id = setTimeout(() => setAnnounce(null), 4000);
    return () => clearTimeout(id);
  }, [announce]);
  const openSheet = (): void => { setAnnounce(null); setPicking(false); setOpen(true); };
  // Every way out (chip, Esc, backdrop, Close) goes through here.
  const close = useCallback((): void => {
    const ui = useArriveByUi.getState();
    if (ui.mode === "arrive-by" && ui.appliedMs === null) {
      ui.chooseLeave();
      setAnnounce("fallback");
    }
    setPicking(false);
    setOpen(false);
  }, []);
  const toggle = (): void => { if (open) close(); else openSheet(); };
  const clock = (ms: number): string => {
    const wall = toCityWallClock(ms, tz);
    if (wall.date === toCityWallClock(Date.now(), tz).date) return wall.time;
    let day = wall.date;
    try { day = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: tz }).format(ms); } catch { /* keep the date */ }
    return `${day} ${wall.time}`;
  };
  const deadlineMs = appliedMs ?? draftMs;
  // Short visible label; the spoken name starts with "When:" and contains the
  // visible text word for word (label in name), plus the mode where the
  // short label leaves it implicit.
  const summary = mode === "arrive-by" && deadlineMs !== null
    ? t("arriveBy.by_short", "By {time}").replace("{time}", clock(deadlineMs))
    : leaveAtMs !== null ? t("arriveBy.leave_short", "Leave {time}").replace("{time}", clock(leaveAtMs))
    : t("arriveBy.now", "Now");
  const summaryMode = mode === "arrive-by" && deadlineMs !== null
    ? t("arriveBy.arrive_by", "Arrive by")
    : leaveAtMs === null ? t("arriveBy.leave_now", "Leave now") : null;

  // A preset applies and closes in one step. Pick time is a draft until
  // Done, so the results do not re-route behind the sheet while typing.
  const chooseLeaveOption = (option: LeaveOption): void => {
    const ui = useArriveByUi.getState();
    if (option === "custom") {
      const w = toCityWallClock(leaveAtMs ?? Date.now(), tz);
      setLeaveDate(w.date);
      setLeaveTime(w.time);
      setPicking(true);
      return;
    }
    if (option === "now") ui.setLeaveAt("now", null);
    else ui.setLeaveAt(option, Date.now() + (option === "in15" ? 15 : option === "in30" ? 30 : 60) * 60_000);
    setAnnounce("summary");
    setPicking(false);
    setOpen(false);
  };
  const editLeave = (date: string, time: string): void => {
    setLeaveDate(date);
    setLeaveTime(time);
  };
  const leaveDraftMs = fromCityWallClock(leaveDate, leaveTime, tz);
  const doneLeave = (): void => {
    if (leaveDraftMs !== null) useArriveByUi.getState().setLeaveAt("custom", leaveDraftMs);
    setAnnounce("summary");
    setPicking(false);
    setOpen(false);
  };
  const showLeaveInputs = picking || leaveOption === "custom";

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
    // The arrive-by results announce their own progress and outcome.
    setAnnounce(null);
    setOpen(false);
  };
  const canApply = mode === "arrive-by" && draftMs !== null && draftMs !== appliedMs;

  return (
    <div data-testid="arrive-by-toolbar">
      {/* Time and sort share a row until the sort chip would be cut too short
          to tell its choices apart; it then takes a row of its own. */}
      <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={summaryClass} data-testid="when-summary" aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
          <span className="sr-only">{`${t("arriveBy.when", "When")}: `}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0 text-accent">
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
          </svg>
          <span>{summary}</span>
          {summaryMode && <span className="sr-only">{` (${summaryMode})`}</span>}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={`shrink-0 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {appliedMs !== null && origin && destination ? arriveBySort : sort}
      </div>
      {filters}
      </div>
      {/* Always mounted so screen readers pick up the change; no status
          role, which the arrive-by results own. */}
      <span aria-live="polite" aria-atomic="true" className="sr-only" data-testid="when-status">
        {announce === "fallback" ? t("arriveBy.not_applied", "Arrive by not applied")
          : announce === "summary" ? `${t("arriveBy.when", "When")}: ${summary}` : ""}
      </span>
      {announce === "fallback" && (
        <p className="mt-1.5 text-xs text-fg-secondary" aria-hidden="true">{t("arriveBy.not_applied", "Arrive by not applied")}</p>
      )}
      {open && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          {/* Backdrop: a tap outside closes, like Esc. Not a tab stop. */}
          <button type="button" tabIndex={-1} aria-hidden="true" data-testid="when-backdrop"
            className="absolute inset-0 bg-black/40" onClick={close} />
          <BottomSheet onClose={close} height="full" ariaLabel={t("arriveBy.when", "When")} data-testid="when-sheet"
            className="relative flex max-h-[85dvh] flex-col rounded-t-2xl bg-surface-raised text-fg shadow-lg">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-[min(1rem,16px)] pt-3 pb-2">
              <h2 className="text-base font-semibold">{t("arriveBy.when", "When")}</h2>
              <div className="flex gap-1 p-[min(0.25rem,4px)] rounded-lg border border-divider bg-input-bg" role="group"
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
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("arriveBy.leave_at", "Leave at")}>
                    {LEAVE_OPTIONS.map(([option, key, fallback]) => {
                      const pressed = option === "custom" ? showLeaveInputs : !picking && leaveOption === option;
                      return (
                        <button key={option} type="button" aria-pressed={pressed} data-testid={`leave-${option}`}
                          className={chipClass(pressed)} onClick={() => chooseLeaveOption(option)}>
                          {t(key, fallback)}
                        </button>
                      );
                    })}
                  </div>
                  {showLeaveInputs && (
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
                  </div>
                  {tz !== deviceTz() && (
                    <p className="text-xs text-fg-muted">{t("arriveBy.city_time", "Times are in {zone}.").replace("{zone}", tz)}</p>
                  )}
                </div>
              )}
            </div>
            {/* Sticky footer: the way out is always on screen. */}
            <div className="flex gap-2 border-t border-divider px-[min(1rem,16px)] py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <button type="button" onClick={close} data-testid="when-close"
                className="min-h-11 flex-1 rounded-lg border border-divider px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                {t("trip.close", "Close")}
              </button>
              {mode === "arrive-by" && (
                <button type="button" disabled={!canApply} onClick={apply} data-testid="arrive-by-apply"
                  className="min-h-11 flex-1 px-4 text-sm font-semibold rounded-lg bg-accent text-badge-text disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {t("arriveBy.apply", "Apply")}
                </button>
              )}
              {mode === "leave" && showLeaveInputs && (
                <button type="button" disabled={leaveDraftMs === null} onClick={doneLeave} data-testid="leave-done"
                  className="min-h-11 flex-1 px-4 text-sm font-semibold rounded-lg bg-accent text-badge-text disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {t("arriveBy.done", "Done")}
                </button>
              )}
            </div>
          </BottomSheet>
        </div>,
        document.body,
      )}
    </div>
  );
}
