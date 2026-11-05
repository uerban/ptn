import { useTranslation } from "../i18n/index.ts";

/**
 * Transient per-search signal that a `remote-primary` search hit a `plan()` rejection and we
 * fell back to on-device routing. Distinct from `error`/`engineError`: those are terminal
 * failure surfaces; this is an *informational* banner shown alongside the recovered on-device
 * routes.

 *
 * The remote→on-device fallback always recovers in S2b-2a (the local index is
 * loaded — remote-primary requires it, since the current transport composes via
 * the index). The two values differ only in CAUSE/copy: `-offline` vs `-server`,
 * picked by `isDeviceOnline()`. (A genuinely index-free thin-client — where the
 * server fails AND on-device can't run — is the Phase-2 coordinate RoutingSource;
 * its "routing unavailable offline" state lands then.)
 */
export type RoutingFallbackSignal = "fallback-offline" | "fallback-server";

const COPY: Record<RoutingFallbackSignal, { key: string; fallback: string }> = {
  "fallback-offline": { key: "routing.fallback_offline", fallback: "Offline — showing on-device routes" },
  "fallback-server": { key: "routing.fallback_server", fallback: "Server unavailable — showing on-device routes" },
};

export function RoutingFallbackNotice({ signal }: { signal: RoutingFallbackSignal | null }) {
  const { t } = useTranslation();
  if (signal == null) return null;
  const copy = COPY[signal];
  return (
    <div
      data-testid="routing-fallback-notice"
      role="status"
      className="rounded-lg bg-warning/10 text-warning px-3 py-1.5 text-xs"
    >
      {t(copy.key, copy.fallback)}
    </div>
  );
}
