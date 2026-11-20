import { useLayoutEffect, useRef, useState } from "react";
import type { TransportMode } from "@pt/shared";
import { TransportModeIcon } from "../TransportModeIcon.tsx";
import { searchBadgeChipClass, searchChipClass } from "./searchChip.ts";

export interface VehicleFilter {
  id: string;
  groupId?: string;
  mode: TransportMode;
  label: string;
  excluded: boolean;
  onClick: () => void;
}

function chipClass(item: VehicleFilter, full: boolean): string {
  return full ? searchChipClass(item.excluded ? "off" : "on") : searchBadgeChipClass(item.excluded);
}

export function VehicleFilters({ items, label }: { items: VehicleFilter[]; label: string }) {
  const row = useRef<HTMLDivElement>(null);
  const sizing = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>();

  useLayoutEffect(() => {
    const container = row.current;
    const samples = sizing.current;
    if (!container || !samples) return;

    const fit = () => {
      const widths = Array.from(samples.children, (sample) => sample.getBoundingClientRect().width);
      const gap = parseFloat(getComputedStyle(container).columnGap) || 0;
      let remaining = container.clientWidth - gap * (items.length - 1);
      const next = new Set<string>();
      items.forEach((item, index) => {
        // Groups can share one badge, so their names are needed to tell them apart.
        if (item.groupId) next.add(item.id);
        remaining -= widths[index * 2 + (item.groupId ? 1 : 0)];
      });
      for (const excluded of [false, true]) {
        items.forEach((item, index) => {
          if (item.groupId || item.excluded !== excluded) return;
          const extra = widths[index * 2 + 1] - widths[index * 2];
          if (extra > remaining) return;
          next.add(item.id);
          remaining -= extra;
        });
      }
      setExpanded((current) => current?.size === next.size && [...next].every((id) => current.has(id))
        ? current : next);
    };

    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    for (const sample of samples.children) observer.observe(sample);
    return () => observer.disconnect();
  }, [items]);

  return (
    <div ref={row} className="relative flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {items.map((item) => {
        const full = !expanded || expanded.has(item.id);
        return (
          <button key={item.id} type="button" data-testid={item.groupId ? `route-group-${item.groupId}` : undefined} onClick={item.onClick}
            aria-pressed={!item.excluded} aria-label={item.label} title={item.label}
            className={`${chipClass(item, full)} max-w-full`}>
            <TransportModeIcon mode={item.mode} size="sm" />
            {full && <span className="min-w-0 whitespace-normal break-words">{item.label}</span>}
          </button>
        );
      })}
      <div className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden" aria-hidden="true">
        <div ref={sizing} className="flex w-max">
          {items.flatMap((item) => [false, true].map((full) => (
            <span key={`${item.id}-${full}`} className={chipClass(item, full)}>
              <TransportModeIcon mode={item.mode} size="sm" />
              {full && <span>{item.label}</span>}
            </span>
          )))}
        </div>
      </div>
    </div>
  );
}
