import { useEffect, useId, useMemo, useState } from "react";
import type { RoutingBundleData, ServiceNotice } from "@pt/shared";
import { serviceDayToUnix } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { usePresentationText, type PresentationText } from "../../i18n/presentationStrings.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useCityDataStore } from "../../services/cityData.ts";
import { useActiveNotices } from "../../services/useNotices.ts";
import { activeNotices, noticeText, resolveNoticeTripRuns, type NoticeTripRun } from "../../services/notices.ts";
import {
  cancelNoticeReminder,
  remindersSupported,
  restoreNoticeReminders,
  setNoticeReminder,
  useNoticeReminders,
} from "../../services/noticeReminders.ts";
import { safeAlertUrl } from "../ServiceAlerts/ServiceAlertItem.tsx";
import { noticeIcon } from "./NoticeBadge.tsx";

const MINUTE = 60_000;

function useNow(nowMs?: number): number {
  const [now, setNow] = useState(() => nowMs ?? Date.now());
  useEffect(() => {
    if (nowMs !== undefined) return;
    const id = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(id);
  }, [nowMs]);
  return nowMs ?? now;
}

interface Formatters {
  time: (unixSec: number) => string;
  day: (ymd: string) => string;
}

function lineNames(notice: ServiceNotice, wire: RoutingBundleData | undefined): string {
  if (notice.city || !notice.routeIds) return "";
  // Route ids are feed-internal: name only the lines the loaded bundle knows.
  return notice.routeIds
    .map((id) => wire?.routes.find((r) => r.id === id)?.shortName)
    .filter(Boolean)
    .join(", ");
}

function describe(notice: ServiceNotice, locale: string, text: PresentationText, fmt: Formatters): string {
  return noticeText(notice, locale)
    ?? (notice.kind === "event"
      ? text("notices.eventOn", { date: fmt.day(notice.displayUntil) })
      : notice.kind === "free"
        ? text("notices.free")
        : text("notices.seasonalUntil", { date: fmt.day(notice.displayUntil) }));
}

function CatchIt({ notice, runs, wire, line, nowMs, fmt }: {
  notice: ServiceNotice;
  runs: NoticeTripRun[];
  wire: RoutingBundleData;
  line: string;
  nowMs: number;
  fmt: Formatters;
}) {
  const text = usePresentationText();
  const { locale } = useTranslation();
  const tz = useCityStore((s) => s.activeCity.tz);
  const reminder = useNoticeReminders((s) => s.byId[notice.id]);
  const [supported] = useState(remindersSupported);
  const stopName = (id: string) => wire.stops.find((s) => s.id === id)?.name ?? id;
  const upcoming = runs.find((run) => run.startUnix * 1000 > nowMs);
  // The wire carries one entry per stop pattern; a run's trip is on one of them.
  const tripOf = (run: NoticeTripRun) => {
    for (const route of wire.routes) {
      if (route.id !== run.routeId) continue;
      const trip = route.trips.find((t) => t.tripId === run.tripId);
      if (trip) return { route, trip };
    }
    return undefined;
  };
  const firstStop = (run: NoticeTripRun) => {
    const found = tripOf(run);
    const index = found?.trip.departureSecs.findIndex((secs) => secs >= 0) ?? -1;
    return found && index >= 0 ? stopName(found.route.stopIds[index]!) : "";
  };

  const remind = async () => {
    if (!upcoming) return;
    const time = fmt.time(upcoming.startUnix);
    await setNoticeReminder(notice.id, upcoming.startUnix * 1000, {
      title: text("notices.reminderTitle", { line }),
      body: text("notices.reminderBody", { notice: describe(notice, locale, text, fmt), stop: firstStop(upcoming), time }),
    });
  };

  return (
    <div data-testid="notice-catch-it" className="mt-2">
      <h4 className="text-sm font-semibold">{text("notices.catchIt")}</h4>
      <p className="text-xs text-fg-secondary">{text("notices.catchItIntro")}</p>
      <ul className="list-none m-0 p-0 mt-1 flex flex-col gap-1">
        {runs.map((run) => {
          const found = tripOf(run);
          if (!found) return null;
          const { route, trip } = found;
          return (
            <li key={`${run.tripId}-${run.serviceDate}`} data-testid="notice-trip">
              <details>
                <summary className="text-sm cursor-pointer">
                  {text("notices.tripAt", { stop: firstStop(run), time: fmt.time(run.startUnix) })}
                </summary>
                <ol className="list-none m-0 p-0 pl-3 text-xs text-fg-secondary">
                  {trip.departureSecs.map((secs, i) => secs < 0 ? null : (
                    <li key={route.stopIds[i]! + i}>
                      <span className="tabular-nums">{fmt.time(serviceDayToUnix(run.serviceDate, secs, tz))}</span>{" "}
                      {stopName(route.stopIds[i]!)}
                    </li>
                  ))}
                </ol>
              </details>
            </li>
          );
        })}
      </ul>
      {supported && upcoming && (
        reminder ? (
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span role="status">{text("notices.reminderSet", { time: fmt.time(reminder.at / 1000) })}</span>
            <button type="button" className="underline min-h-11" onClick={() => cancelNoticeReminder(notice.id)}>
              {text("notices.cancelReminder")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-testid="notice-remind"
            className="mt-1 min-h-11 px-3 rounded-lg border border-divider text-sm"
            onClick={() => void remind()}
          >
            {text("notices.remindMe")}
          </button>
        )
      )}
    </div>
  );
}

/**
 * "Special lines this season": the notices running now or starting within
 * 24 hours, with their text and source. Trip-level events add the trips to
 * catch and an optional local reminder. Hidden when there are none.
 */
export function SpecialServicesList({ placement = "inline", nowMs }: { placement?: "inline" | "overlay"; nowMs?: number }) {
  const text = usePresentationText();
  const { locale, formattingLocale } = useTranslation();
  const headingId = useId();
  const city = useCityStore((s) => s.activeCity);
  const wire = useCityDataStore((s) => s.active?.wire);
  const { notices } = useActiveNotices();
  const now = useNow(nowMs);
  useEffect(() => restoreNoticeReminders(), []);
  const shown = useMemo(() => activeNotices(notices, now), [notices, now]);
  const runs = useMemo(
    () => (wire && shown.some((n) => n.trips) ? resolveNoticeTripRuns(shown, wire.routes, wire.calendar, city.tz) : []),
    [wire, shown, city.tz],
  );
  if (!shown.length) return null;

  const fmt: Formatters = {
    time: (unix) => new Date(unix * 1000).toLocaleTimeString(formattingLocale, { hour: "2-digit", minute: "2-digit", timeZone: city.tz }),
    day: (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(formattingLocale, { day: "numeric", month: "long", timeZone: "UTC" }),
  };

  return (
    <section
      aria-labelledby={headingId}
      data-testid="special-services"
      className={placement === "overlay"
        ? "pointer-events-auto mx-3 mt-2 sm:ml-auto sm:w-96 rounded-xl bg-surface-raised shadow-2 border border-divider p-3 text-fg"
        : "mx-3 mt-3 rounded-xl bg-surface-raised shadow-1 border border-divider p-3 text-fg"}
    >
      <h2 id={headingId} className="text-base font-semibold">{text("notices.listTitle")}</h2>
      <ul className="list-none m-0 p-0 mt-1 flex flex-col gap-3">
        {shown.map((notice) => {
          const line = lineNames(notice, wire);
          const href = safeAlertUrl(notice.source);
          const own = runs.filter((run) => run.noticeId === notice.id);
          return (
            <li key={notice.id} data-testid="special-service" data-notice={notice.id}>
              <h3 className="text-sm font-semibold">
                <span aria-hidden="true">{noticeIcon(notice)} </span>
                {line ? text("notices.legNotice", { line, notice: describe(notice, locale, text, fmt) }) : describe(notice, locale, text, fmt)}
              </h3>
              {notice.free && !(notice.kind === "free" && !noticeText(notice, locale)) && (
                <p className="text-sm text-success">{text("notices.free")}</p>
              )}
              {href && (
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs underline">
                  {text("notices.source")} <span className="sr-only">{text("serviceAlerts.leavesApp")}</span>
                </a>
              )}
              {wire && own.length > 0 && <CatchIt notice={notice} runs={own} wire={wire} line={line} nowMs={now} fmt={fmt} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
