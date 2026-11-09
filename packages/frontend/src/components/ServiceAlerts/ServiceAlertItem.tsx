import { useId, useState } from "react";
import type { Alert, AlertSeverity, AlertTranslation } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import {
  usePresentationText,
  type PresentationStringKey,
} from "../../i18n/presentationStrings.ts";
import { pickTranslation } from "../../services/serviceAlertSelection.ts";
import { Icon } from "../Icon.tsx";

/** Descriptions longer than this collapse behind **Show more**. */
export const ALERT_COLLAPSE_CHARS = 160;

const SEVERITY_KEY: Record<AlertSeverity, PresentationStringKey> = {
  SEVERE: "serviceAlerts.severity.SEVERE",
  WARNING: "serviceAlerts.severity.WARNING",
  INFO: "serviceAlerts.severity.INFO",
  UNKNOWN: "serviceAlerts.severity.UNKNOWN",
};

const SEVERITY_TONE: Record<AlertSeverity, string> = {
  SEVERE: "text-danger",
  WARNING: "text-warning-fg",
  INFO: "text-fg-secondary",
  UNKNOWN: "text-fg-secondary",
};

/** `lang` for feed text whose language differs from the UI's. */
export function langAttribute(
  translation: AlertTranslation | undefined,
  uiLocale: string,
): string | undefined {
  const language = translation?.language;
  if (!language) return undefined;
  const primary = (tag: string) => tag.toLowerCase().split(/[-_]/)[0];
  return primary(language) === primary(uiLocale) ? undefined : language;
}

/** Only web links leave the app; anything else is not shown as a link. */
export function safeAlertUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Severity as a word and a shape, never as color alone. */
export function SeverityLabel({ severity }: { severity: AlertSeverity }) {
  const text = usePresentationText();
  return (
    <span
      data-testid="service-alert-severity"
      data-severity={severity}
      className={`inline-flex items-center gap-1 text-xs font-semibold ${SEVERITY_TONE[severity]}`}
    >
      {severity === "SEVERE" || severity === "WARNING" ? (
        <Icon name="warning" size={14} />
      ) : (
        <span aria-hidden className="inline-flex w-3.5 h-3.5 items-center justify-center rounded-full border border-current text-[9px] leading-none">
          i
        </span>
      )}
      {text(SEVERITY_KEY[severity])}
    </span>
  );
}

/**
 * One service alert: severity, header, the description (long text collapses
 * behind **Show more**) and an external link marked as leaving the app.
 * Feed text in another language than the UI carries its own `lang`.
 */
export function ServiceAlertItem({
  alert,
  lines = [],
}: {
  alert: Alert;
  /** Lines of the user's trip this alert concerns (route results). */
  lines?: readonly string[];
}) {
  const text = usePresentationText();
  const { locale } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const descriptionId = useId();
  const header = pickTranslation(alert.header, locale);
  const description = pickTranslation(alert.description, locale);
  const link = pickTranslation(alert.url, locale);
  const href = safeAlertUrl(link?.text);
  const long = (description?.text.length ?? 0) > ALERT_COLLAPSE_CHARS;

  return (
    <li
      data-testid="service-alert"
      data-alert-id={alert.id}
      data-severity={alert.severity}
      className="flex flex-col gap-1 px-3 py-2 rounded-lg border border-divider bg-surface-overlay"
    >
      <span className="flex flex-wrap items-center gap-2">
        <SeverityLabel severity={alert.severity} />
        {lines.length > 0 && (
          <span data-testid="service-alert-lines" className="text-xs font-semibold text-fg">
            {text("serviceAlerts.lines", { lines: lines.join(", ") })}
          </span>
        )}
      </span>
      {header && (
        <p lang={langAttribute(header, locale)} className="text-sm font-medium text-fg break-words">
          {header.text}
        </p>
      )}
      {description && (
        <p
          id={descriptionId}
          lang={langAttribute(description, locale)}
          data-testid="service-alert-description"
          className={`text-xs text-fg-secondary whitespace-pre-line break-words ${
            long && !expanded ? "line-clamp-3" : ""
          }`}
        >
          {description.text}
        </p>
      )}
      {(long || href) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {long && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={descriptionId}
              onClick={() => setExpanded((v) => !v)}
              className="min-h-9 text-xs font-medium text-accent"
            >
              {expanded ? text("serviceAlerts.showLess") : text("serviceAlerts.showMore")}
            </button>
          )}
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="service-alert-link"
              className="min-h-9 inline-flex items-center text-xs font-medium text-accent underline underline-offset-2"
            >
              {text("serviceAlerts.moreInfo")}
              <span className="sr-only"> {text("serviceAlerts.leavesApp")}</span>
              <span aria-hidden className="ml-1">↗</span>
            </a>
          )}
        </div>
      )}
    </li>
  );
}

/** Compact one-line note for places that cannot hold controls (a leg row
 * is itself a button). */
export function ServiceAlertNote({ alert, line }: { alert: Alert; line?: string }) {
  const { locale } = useTranslation();
  const header = pickTranslation(alert.header, locale) ?? pickTranslation(alert.description, locale);
  return (
    <span
      data-testid="service-alert-note"
      data-severity={alert.severity}
      className="flex items-start gap-1.5 text-xs text-fg"
    >
      <SeverityLabel severity={alert.severity} />
      {line && <span className="font-semibold shrink-0">{line}</span>}
      {header && (
        <span lang={langAttribute(header, locale)} className="min-w-0 break-words">
          {header.text}
        </span>
      )}
    </span>
  );
}
