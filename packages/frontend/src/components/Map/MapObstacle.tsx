import { type ReactNode } from "react";
import { useRegisterMapObstacle } from "../../hooks/useRegisterMapObstacle.ts";

interface MapObstacleProps {
  /** Stable id, one per UI element (e.g. "search-bar", "step-list"). */
  id: string;
  /** Skip registration when false (component still renders). */
  enabled?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Wraps a UI element that overlays the map and registers its bounding rect
 * in `mapObstaclesStore`, so marker placement keeps stop labels out from
 * under it. Renders as a `<div>` — same shape the overlay containers in
 * Home.tsx already use, just self-tracking.
 */
export function MapObstacle({ id, enabled = true, className, children }: MapObstacleProps) {
  const ref = useRegisterMapObstacle<HTMLDivElement>(id, enabled);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
