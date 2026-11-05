import type { Leg, UpcomingStop, ConnectionAtStop } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { Icon } from "../Icon.tsx";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { getBadgeMinWidth } from "../../utils/appearance.ts";

interface RiderDashboardProps {
  leg: Leg;
  upcomingStops: UpcomingStop[];
  connectingDepartures: ConnectionAtStop[];
  onExit: () => void;
}

export function RiderDashboard({
  leg,
  upcomingStops,
  connectingDepartures,
  onExit,
}: RiderDashboardProps) {
  const { t } = useTranslation();
  const variant = useSettingsStore((s) => s.routeSearchVariant);
  const destinationStopId = leg.to.stopId;

  return (
    <div
      data-testid="rider-dashboard"
      role="region"
      aria-live="polite"
      aria-label={t("guidance.rider_dashboard", "Rider dashboard")}
      className="bg-surface-raised rounded-t-2xl shadow-2 max-h-[60vh] overflow-hidden flex flex-col"
    >
      {/* Header: route badge + headsign + exit */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <span
            className="font-bold text-center rounded-md px-2 py-0.5 shrink-0 text-badge-text"
            style={{
              "--route-color": leg.routeColor ? `#${leg.routeColor}` : "#6b7280",
              backgroundColor: "var(--route-color)",
              fontSize: "var(--variant-primary-text-size)",
              minWidth: getBadgeMinWidth(variant),
            } as React.CSSProperties}
          >
            {leg.routeShortName}
          </span>
          <span className="text-base font-semibold text-fg truncate">
            {leg.headsign}
          </span>
        </div>
        <button
          onClick={onExit}
          className="p-2 rounded-full hover:bg-surface-overlay"
          aria-label={t("guidance.rider_exit", "Exit rider mode")}
        >
          <Icon name="close" className="text-fg-muted" />
        </button>
      </div>

      {/* Upcoming stops with connecting line */}
      <div className="overflow-y-auto flex-1 px-4 py-3">
        <div className="relative">
          {/* Vertical connecting line */}
          <div className="absolute left-[7px] top-3 bottom-3 w-0.5 bg-divider" />

          <div className="space-y-0">
            {upcomingStops.map((stop) => {
              const isDestination = stop.id === destinationStopId;
              const connections = connectingDepartures.find(
                (c) => c.stopName === stop.name
              );

              return (
                <div
                  key={stop.id}
                  className="relative"
                  style={{
                    paddingLeft: "1.5rem",
                    paddingTop: "0.5rem",
                    paddingBottom: "1rem",
                    borderBottom: "1px solid var(--variant-row-separator)",
                  }}
                >
                  {/* Stop dot */}
                  <div
                    className={`absolute left-0 top-1 w-[15px] h-[15px] rounded-full border-2 z-10 ${
                      isDestination
                        ? "bg-accent border-accent"
                        : "bg-surface-raised border-fg-muted"
                    }`}
                  />

                  {/* Stop name */}
                  <div
                    data-destination={isDestination || undefined}
                    className={`${isDestination ? "font-bold text-accent" : "text-fg"}`}
                    style={{ fontSize: "var(--variant-primary-text-size)" }}
                  >
                    {stop.name}
                  </div>

                  {/* Connecting departures at this stop */}
                  {connections && (
                    <div
                      data-testid={`connecting-departures-${stop.id}`}
                      className="mt-1 flex flex-wrap gap-1.5"
                    >
                      {connections.departures.length === 0 ? (
                        <p
                          data-testid="dashboard-no-upcoming"
                          className="text-xs text-fg-muted"
                        >
                          {t(
                            "dashboard.no_upcoming_connections",
                            "No upcoming connections",
                          )}
                        </p>
                      ) : (
                        connections.departures.map((dep, j) => (
                          <div
                            key={j}
                            data-testid="connection-chip"
                            className="flex items-center gap-1 text-fg-muted bg-surface-overlay rounded px-1.5 py-0.5"
                            style={{ fontSize: "var(--variant-meta-text-size)" }}
                            aria-label={
                              dep.isApproximate
                                ? t(
                                    "dashboard.connection_approx_aria",
                                    "{line} {headsign}, {n} minutes, approximate",
                                  )
                                    .replace("{line}", dep.routeShortName)
                                    .replace("{headsign}", dep.headsign)
                                    .replace("{n}", String(dep.minutesUntil))
                                : undefined
                            }
                          >
                            <span className="font-bold text-fg-secondary">
                              {dep.routeShortName}
                            </span>
                            <span className="truncate max-w-[80px]">
                              {dep.headsign}
                            </span>
                            <span className="text-fg-muted">
                              {dep.isApproximate ? "~" : ""}
                              {t("unit.minutes_compact", "{n}m").replace(
                                "{n}",
                                String(dep.minutesUntil),
                              )}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
