import { useState } from "react";
import { useTranslation } from "../../i18n/index.ts";
import { clearRecents } from "../../services/recents.ts";

export interface RecentsPurgeControlProps {
  /** Test hook: replace the destructive confirmation prompt. */
  confirmFn?: (message: string) => boolean;
  /** Test hook: replace the underlying purge call. */
  onPurge?: () => Promise<void>;
}

export function RecentsPurgeControl({
  confirmFn,
  onPurge,
}: RecentsPurgeControlProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [purged, setPurged] = useState(false);

  const message = t(
    "settings.recents_purge_confirm",
    "Delete every recent location stored on this device? This cannot be undone.",
  );

  async function handleClick() {
    const ask = confirmFn ?? ((m: string) => window.confirm(m));
    if (!ask(message)) return;
    setBusy(true);
    try {
      await (onPurge ?? clearRecents)();
      setPurged(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
        {t("settings.recents_data", "Recent locations")}
      </h2>
      <div className="bg-surface-raised rounded-xl border border-divider px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-fg">
            {t("settings.recents_purge_label", "Clear recent locations")}
          </p>
          <p className="text-xs text-fg-muted">
            {t(
              "settings.recents_purge_desc",
              "Remove every place you have used as an origin or destination, including encrypted and RAM-only entries.",
            )}
          </p>
          {purged && (
            <p
              role="status"
              className="text-xs text-accent mt-1"
            >
              {t("settings.recents_purge_done", "Recent locations cleared.")}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleClick}
          disabled={busy}
          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-danger text-danger hover:bg-danger/10 disabled:opacity-50"
        >
          {busy
            ? t("settings.recents_purge_busy", "Clearing…")
            : t("settings.recents_purge_button", "Purge")}
        </button>
      </div>
    </section>
  );
}
