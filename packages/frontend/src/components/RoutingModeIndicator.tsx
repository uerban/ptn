import { Link } from "react-router-dom";
import { useSettingsStore, type RoutingMode } from "../stores/settingsStore.ts";
import { usePolicy } from "../stores/privacyStore.ts";
import { useTranslation } from "../i18n/index.ts";
import { isRemoteRoutingAllowed } from "../services/routingSource.ts";

/**
 * Persistent, revocable indicator of the standing routing source. Visible for any standing
 * remote mode the privacy ceiling permits — so the user always sees that the server is involved
 * in routing and can change it. Copy is mode-specific: `provider-fallback` → "Server fallback
 * on"; `remote-primary` → "Routing on server". The use-time `remoteAllowed` gate means a stored
 * remote mode that is currently over-ceiling shows nothing (the mode is inert until privacy is
 * lowered).

 *

 * * S2b-1 uses generic "server" copy; naming the specific provider lands with the Phase-2
 * multi-provider selector.
 */
export function RoutingModeIndicator() {
  const { t } = useTranslation();
  const routingMode = useSettingsStore((s) => s.routingMode);
  const remoteAllowed = isRemoteRoutingAllowed(usePolicy());
  // Visible for any standing remote mode the ceiling currently permits. A stored
  // remote mode that is over-ceiling shows nothing (inert until privacy lowers).
  if (routingMode === "on-device" || !remoteAllowed) return null;
  const LABEL: Record<Exclude<RoutingMode, "on-device">, { key: string; fallback: string }> = {
    "provider-fallback": { key: "routing.indicator_fallback", fallback: "Server fallback on" },
    "remote-primary": { key: "routing.indicator_remote_primary", fallback: "Routing on server" },
  };
  const label = t(LABEL[routingMode].key, LABEL[routingMode].fallback);
  return (
    <div
      data-testid="routing-mode-indicator"
      role="status"
      className="flex items-center justify-between gap-2 rounded-lg bg-accent/10 text-accent px-3 py-1.5 text-xs"
    >
      <span>{label}</span>
      <Link
        to="/settings#routing-source"
        data-testid="routing-mode-indicator-change"
        className="font-medium underline-offset-2 hover:underline"
      >
        {t("routing.indicator_change", "Change")}
      </Link>
    </div>
  );
}
