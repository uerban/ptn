import type { ServiceNotice } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import { noticeText } from "../../services/notices.ts";

const KIND_ICON: Record<ServiceNotice["kind"], string> = { seasonal: "🎄", event: "🔔", free: "🎟️" };

export function noticeIcon(notice: ServiceNotice): string {
  return notice.icon ?? KIND_ICON[notice.kind];
}

/**
 * Marks a ride covered by special-service notices: the icon is decoration,
 * the words ("Free ride", the editor's text) carry the meaning.
 */
export function NoticeBadge({ notices, compact = false }: { notices: readonly ServiceNotice[]; compact?: boolean }) {
  const text = usePresentationText();
  const { locale, formattingLocale } = useTranslation();
  const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(formattingLocale, { day: "numeric", month: "long", timeZone: "UTC" });
  if (!notices.length) return null;
  const free = notices.some((n) => n.free);
  const described = notices
    .map((n) => noticeText(n, locale)
      ?? (n.kind === "seasonal" ? text("notices.seasonalUntil", { date: day(n.displayUntil) })
        : n.kind === "event" ? text("notices.eventOn", { date: day(n.displayUntil) }) : undefined))
    .filter(Boolean)
    .join("; ");
  const label = [free ? text("notices.free") : undefined, described || undefined].filter(Boolean).join(": ");
  return (
    <span
      data-testid="service-notice-badge"
      data-notices={notices.map((n) => n.id).join(" ")}
      className="inline-flex items-center gap-0.5 text-xs font-medium text-fg-secondary"
      title={label || undefined}
    >
      <span aria-hidden="true">{[...new Set(notices.map(noticeIcon))].join("")}</span>
      {label && (compact ? <span className="sr-only">{label}</span> : <span>{free ? text("notices.free") : described}</span>)}
    </span>
  );
}
