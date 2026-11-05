import { useState } from "react";
import { useTranslation } from "../../i18n/index.ts";
import {
  clearDownloadedData,
  deletePersonalHistory,
  resetPtnCompletely,
} from "../../services/dataDeletion.ts";

type DeletionAction = "history" | "downloads" | "reset";

export interface DataDeletionControlsProps {
  confirmFn?: (message: string) => boolean;
  deleteHistory?: () => Promise<void>;
  clearDownloads?: () => Promise<void>;
  resetPtn?: () => Promise<void>;
}

export function DataDeletionControls({
  confirmFn,
  deleteHistory,
  clearDownloads,
  resetPtn,
}: DataDeletionControlsProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<DeletionAction | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const actionCopy: Record<
    DeletionAction,
    { button: string; confirm: string; done: string; description: string }
  > = {
    history: {
      button: t("privacy.deletion.history_button", "Delete personal history"),
      confirm: t(
        "privacy.deletion.history_confirm",
        "Delete recent places, saved places and journeys, stop-use counts, local delay reports, and the last map area? Downloaded transit data and settings will stay.",
      ),
      done: t("privacy.deletion.history_done", "Personal history deleted."),
      description: t(
        "privacy.deletion.history_desc",
        "Removes recent and saved places, journeys, local reports, stop-use counts, and the remembered map area.",
      ),
    },
    downloads: {
      button: t(
        "privacy.deletion.downloads_button",
        "Clear downloaded public data",
      ),
      confirm: t(
        "privacy.deletion.downloads_confirm",
        "Clear downloaded transit schedules, stops, place data, and PTN/CARTO map caches? PTN will download them again when needed. Personal history and settings will stay.",
      ),
      done: t(
        "privacy.deletion.downloads_done",
        "Downloaded public data cleared.",
      ),
      description: t(
        "privacy.deletion.downloads_desc",
        "Removes reproducible schedules, stops, place indexes, and PTN/CARTO caches. Your own data stays.",
      ),
    },
    reset: {
      button: t("privacy.deletion.reset_button", "Reset PTN completely"),
      confirm: t(
        "privacy.deletion.reset_confirm",
        "Remove all PTN data, settings, choices, downloads, and PTN-owned caches from this browser? This cannot be undone. Other websites' data will not be touched.",
      ),
      done: t(
        "privacy.deletion.reset_done",
        "PTN reset complete. Reloading…",
      ),
      description: t(
        "privacy.deletion.reset_desc",
        "Removes everything owned by PTN in this browser, then reloads. Unrelated website storage and caches stay.",
      ),
    },
  };

  const actions: Record<DeletionAction, () => Promise<void>> = {
    history: deleteHistory ?? deletePersonalHistory,
    downloads: clearDownloads ?? clearDownloadedData,
    reset: resetPtn ?? resetPtnCompletely,
  };

  async function run(action: DeletionAction): Promise<void> {
    const copy = actionCopy[action];
    const ask = confirmFn ?? ((message: string) => globalThis.confirm(message));
    if (!ask(copy.confirm)) return;
    setBusy(action);
    setStatus(null);
    setError(null);
    try {
      await actions[action]();
      setStatus(copy.done);
    } catch {
      setError(
        t(
          "privacy.deletion.error",
          "Some PTN data could not be cleared. Nothing outside PTN was touched; please try again.",
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-fg-muted">
        {t("privacy.deletion.heading", "Delete data")}
      </h2>
      <div className="rounded-xl border border-divider bg-surface-raised px-4">
        <DeletionRow
          title={actionCopy.history.button}
          description={actionCopy.history.description}
          busy={busy === "history"}
          busyLabel={t("privacy.deletion.clearing", "Clearing…")}
          disabled={busy !== null}
          onClick={() => void run("history")}
          danger
        />
        <DeletionRow
          title={actionCopy.downloads.button}
          description={actionCopy.downloads.description}
          busy={busy === "downloads"}
          busyLabel={t("privacy.deletion.clearing", "Clearing…")}
          disabled={busy !== null}
          onClick={() => void run("downloads")}
        />
        <DeletionRow
          title={actionCopy.reset.button}
          description={actionCopy.reset.description}
          busy={busy === "reset"}
          busyLabel={t("privacy.deletion.clearing", "Clearing…")}
          disabled={busy !== null}
          onClick={() => void run("reset")}
          danger
          last
        />
      </div>
      <div aria-live="polite" aria-atomic="true">
        {status && (
          <p role="status" className="mt-2 text-xs text-accent">
            {status}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function DeletionRow({
  title,
  description,
  busy,
  busyLabel,
  disabled,
  onClick,
  danger = false,
  last = false,
}: {
  title: string;
  description: string;
  busy: boolean;
  busyLabel: string;
  disabled: boolean;
  onClick: () => void;
  danger?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-3 ${
        last ? "" : "border-b border-divider"
      }`}
    >
      <div className="min-w-0">
        <p className="text-sm text-fg">{title}</p>
        <p className="text-xs text-fg-muted">{description}</p>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
          danger
            ? "border-danger text-danger hover:bg-danger/10"
            : "border-divider text-fg-secondary hover:border-accent"
        }`}
      >
        {busy ? busyLabel : title}
      </button>
    </div>
  );
}
