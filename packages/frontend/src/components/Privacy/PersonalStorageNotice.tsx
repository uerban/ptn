import { useState } from "react";
import { useTranslation } from "../../i18n/index.ts";
import {
  isPersonalStorageSessionOnly,
  usePersonalStorageStatus,
} from "../../services/personalStorage.ts";
import {
  deleteAllPersonalData,
  deleteUnreadablePersonalData,
  retryPersonalStorage,
} from "../../services/personalStorageRecovery.ts";

const ENCRYPTED_SHORT = "Saved places and history are encrypted on this device.";

/** Short line shown after something was saved. */
export function SavedStorageNote({ durable }: { durable: boolean }) {
  const { t } = useTranslation();
  return (
    <p role="status" className="text-xs text-fg-muted" data-testid="saved-storage-note">
      {durable
        ? t("privacy.storage.encryptedShort", ENCRYPTED_SHORT)
        : t(
            "privacy.storage.savedSessionOnly",
            "Saved for now. It will not be kept after you close the app.",
          )}
    </p>
  );
}

/** What encryption on this device does and does not do (Settings). */
export function PersonalStorageDetail() {
  const { t } = useTranslation();
  return (
    <div className="mb-3 space-y-1 text-xs text-fg-muted" data-testid="personal-storage-detail">
      <p>{t("privacy.storage.encryptedShort", ENCRYPTED_SHORT)}</p>
      <p>
        {t(
          "privacy.storage.encryptedDetail",
          "This makes them hard to read by looking through the browser's stored data. Anyone who can use this browser profile can still open the app and see them, so delete them if you share this device.",
        )}
      </p>
    </div>
  );
}

export interface PersonalStorageNoticeProps {
  confirmFn?: (message: string) => boolean;
  /** Also say while existing data is being encrypted (Settings only). */
  showProgress?: boolean;
}

/**
 * Polite, non-blocking status for personal storage: shown only when saves and
 * history cannot be kept, earlier data is not yet encrypted, or some records
 * cannot be read. Transit features keep working in every case.
 */
export function PersonalStorageNotice({
  confirmFn,
  showProgress = false,
}: PersonalStorageNoticeProps) {
  const { t } = useTranslation();
  const status = usePersonalStorageStatus();
  const [busy, setBusy] = useState(false);

  const migrationFailed = status.migration === "failed";
  const sessionOnly = isPersonalStorageSessionOnly(status);
  const unreadable = status.unreadable > 0 || status.keyMode === "key-unreadable";
  const running = showProgress && status.migration === "running";
  if (!migrationFailed && !sessionOnly && !unreadable && !running) {
    return null;
  }

  const confirm =
    confirmFn ??
    ((message: string) =>
      typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(message)
        : false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } catch {
      // The status store reflects the outcome; nothing else to show.
    } finally {
      setBusy(false);
    }
  }

  let message: string;
  if (migrationFailed) {
    message =
      status.failure === "storage-full"
        ? t(
            "privacy.storage.migrationFailedFull",
            "Saved places and history from before could not be encrypted because this device is out of storage space. Free up space, then try again. Transit information still works.",
          )
        : t(
            "privacy.storage.migrationFailed",
            "Saved places and history from before could not be encrypted yet, so they are not shown. Transit information still works. New saves and history are kept until you close the app.",
          );
  } else if (running) {
    message = t(
      "privacy.storage.migrationRunning",
      "Encrypting saved places and history on this device…",
    );
  } else if (status.keyMode === "read-failed") {
    message = t(
      "privacy.storage.keyRetry",
      "The encryption key could not be read. Saves and history you add now are kept until you close the app; the app will try again.",
    );
  } else if (status.keyMode === "key-unreadable") {
    message = t(
      "privacy.storage.keyUnreadable",
      "Saved places and history on this device cannot be read any more, for example because the browser's stored data changed. They are not shown.",
    );
  } else if (sessionOnly) {
    message = t(
      "privacy.storage.sessionOnly",
      "This browser is not letting the app keep encrypted data. Saves and history you add now will not be kept after you close the app.",
    );
  } else {
    message = t(
      "privacy.storage.unreadable",
      "{count} saved items cannot be read on this device any more, for example because the browser's stored data changed. They are not shown.",
    ).replace("{count}", String(status.unreadable));
  }

  const canRetry = migrationFailed || status.keyMode === "read-failed";
  const showDeleteAll = migrationFailed || status.keyMode === "key-unreadable";
  const showDeleteUnreadable = !showDeleteAll && status.unreadable > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="personal-storage-notice"
      className="mx-3 my-2 rounded-lg border border-divider bg-surface-raised p-3 text-sm text-fg"
    >
      <p>{message}</p>
      {(canRetry || showDeleteAll || showDeleteUnreadable) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {canRetry && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(retryPersonalStorage)}
              className="min-h-11 rounded-lg border border-accent px-3 text-accent disabled:opacity-60"
            >
              {t("privacy.storage.retry", "Try again")}
            </button>
          )}
          {showDeleteUnreadable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => deleteUnreadablePersonalData())}
              className="min-h-11 rounded-lg border border-divider px-3 disabled:opacity-60"
            >
              {t("privacy.storage.deleteUnreadable", "Delete unreadable items")}
            </button>
          )}
          {showDeleteAll && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const ok = confirm(
                  t(
                    "privacy.storage.deleteConfirm",
                    "Delete all saved places, favorites and history on this device? This cannot be undone.",
                  ),
                );
                if (ok) void run(() => deleteAllPersonalData());
              }}
              className="min-h-11 rounded-lg border border-divider px-3 disabled:opacity-60"
            >
              {t("privacy.storage.delete", "Delete saved places and history")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
