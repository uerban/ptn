import { Icon } from "../Icon.tsx";

/**
 * A small visual mark on a line affected by a service alert (nearby strip
 * and list, route result legs). The mark is a shape, not a color; it is
 * hidden from assistive technology because the control it sits in names the
 * alert in its accessible label.
 */
export function ServiceAlertIndicator({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      data-testid="service-alert-indicator"
      className={`inline-flex items-center justify-center shrink-0 rounded-full bg-surface-raised text-warning-fg ${className}`}
    >
      <Icon name="warning" size={12} />
    </span>
  );
}
