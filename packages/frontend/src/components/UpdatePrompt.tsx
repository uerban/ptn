import { useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { usePresentationText } from "../i18n/presentationStrings.ts";

/** **Not now** hides the prompt for the rest of this page session. */
let dismissedThisSession = false;

/**
 * Offers a waiting app version. A polite status, not an alert: an available
 * update must not interrupt a screen reader. **Not now** hides it for this
 * session; the new version also takes over once every app window closes.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const text = usePresentationText();
  const [updating, setUpdating] = useState(false);
  const [dismissed, setDismissed] = useState(dismissedThisSession);

  if (!needRefresh || dismissed) return null;

  async function handleUpdate() {
    setUpdating(true);
    try {
      await updateServiceWorker(true);
    } catch (err) {
      console.warn("Service worker update failed:", err);
      setUpdating(false);
    }
  }

  function handleNotNow() {
    dismissedThisSession = true;
    setDismissed(true);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-prompt"
      className="fixed bottom-4 left-4 right-4 z-50 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm text-white shadow-lg sm:left-auto sm:right-4 sm:w-96"
    >
      <span className="flex-1 min-w-[8rem]">{text("update.available")}</span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleNotNow}
          disabled={updating}
          className="min-h-9 rounded px-3 py-1 text-xs font-medium text-white underline-offset-2 hover:underline disabled:opacity-60"
        >
          {text("update.notNow")}
        </button>
        <button
          type="button"
          onClick={handleUpdate}
          disabled={updating}
          className="min-h-9 rounded bg-white px-3 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-60"
        >
          {updating ? text("update.updating") : text("update.action")}
        </button>
      </span>
    </div>
  );
}

/** Test-only: forget this session's **Not now**. */
export function __resetUpdatePromptForTests(): void {
  dismissedThisSession = false;
}
