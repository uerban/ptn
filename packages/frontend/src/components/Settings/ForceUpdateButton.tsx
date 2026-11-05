import { useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { useTranslation } from "../../i18n/index.ts";

export function ForceUpdateButton() {
  const { t } = useTranslation();
  const { updateServiceWorker } = useRegisterSW();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      // Ask the registered SW to check the server for a newer version,
      // so a fresh build (if one is on the server) goes into "waiting"
      // and updateServiceWorker() below can activate it.
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.update()));
      }
      // Clear precache + workbox runtime caches. Even if no new SW is
      // available, an empty cache forces the next request through to
      // the network — fixes the "device stuck on stale JS" loop where
      // the cached precache keeps re-serving the old bundle.
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      // Activate any waiting SW and reload. With no waiting SW this is
      // just a reload — combined with the cache clear above, that's
      // still enough to pull fresh assets.
      await updateServiceWorker(true);
    } catch (err) {
      console.warn("[ForceUpdateButton] reload failed:", err);
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      data-testid="force-update-button"
      className="mt-2 w-full text-xs text-fg-muted hover:text-fg-secondary underline underline-offset-2 disabled:opacity-50 transition-colors"
    >
      {busy
        ? t("settings.force_update_running", "Reloading…")
        : t("settings.force_update", "Reload & clear cache")}
    </button>
  );
}
