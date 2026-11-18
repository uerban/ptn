import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** Horizontal travel that commits a swipe. */
const SWIPE_COMMIT_PX = 80;
/** Movement that turns a press into a drag. */
const SLOP_PX = 10;
const LONG_PRESS_MS = 500;
/** Touches starting this close to the left edge belong to the browser's back gesture. */
const EDGE_GUARD_PX = 24;

export interface RecentRowProps {
  /** Place name, for the actions button label. */
  label: string;
  /** The row's own option button. */
  children: ReactNode;
  /** Recents only: save the place. */
  onSave?: () => void;
  /** Saved rows only: rename the save. */
  onRename?: () => void;
  onRemove: () => void;
  text: {
    actions: string;
    save?: string;
    rename?: string;
    remove: string;
  };
}

/**
 * A recent or saved row with Save (recents) or Rename (saved rows), and Remove.
 * The visible ⋯ menu is the main path and works with keyboard and screen
 * readers; on touch, swipe right saves or renames, swipe left removes and a
 * long press opens the same menu.
 */
export function RecentRow({ label, children, onSave, onRename, onRemove, text }: RecentRowProps) {
  const onRight = onSave ?? onRename;
  const rightLabel = onSave ? text.save : text.rename;
  const [open, setOpen] = useState(false);
  const [dx, setDx] = useState(0);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    x: number;
    y: number;
    dragging: boolean;
    dx: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      const root = menuRef.current?.parentElement;
      if (root && e.target instanceof Node && !root.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const endGesture = () => {
    if (gesture.current?.timer) clearTimeout(gesture.current.timer);
    gesture.current = null;
    setDx(0);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    if (e.clientX < EDGE_GUARD_PX) return;
    const timer = setTimeout(() => {
      if (gesture.current && !gesture.current.dragging) {
        suppressClick.current = true;
        gesture.current = null;
        setOpen(true);
      }
    }, LONG_PRESS_MS);
    gesture.current = { x: e.clientX, y: e.clientY, dragging: false, dx: 0, timer };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const mx = e.clientX - g.x;
    const my = e.clientY - g.y;
    if (!g.dragging) {
      if (Math.abs(my) > SLOP_PX && Math.abs(my) >= Math.abs(mx)) return endGesture();
      if (Math.abs(mx) <= SLOP_PX) return;
      g.dragging = true;
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        // Pointer already gone; the gesture ends on pointerup/cancel.
      }
      if (g.timer) clearTimeout(g.timer);
      g.timer = null;
    }
    // Without Save or Rename, a right swipe has nothing to do: keep the row still.
    const next = onRight ? mx : Math.min(mx, 0);
    g.dx = next;
    setDx(next);
  };

  const onPointerUp = () => {
    const g = gesture.current;
    if (g?.dragging) {
      suppressClick.current = true;
      if (g.dx >= SWIPE_COMMIT_PX) onRight?.();
      else if (g.dx <= -SWIPE_COMMIT_PX) onRemove();
    }
    endGesture();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(i + step + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const reveal = dx > SLOP_PX ? "save" : dx < -SLOP_PX ? "remove" : null;

  return (
    // Clipped sideways: a row pushed right by a swipe must not widen the
    // scrolling list, or the browser takes over the gesture as a sideways
    // scroll, cancels it and the row snaps back. Vertically the menu still
    // shows below the row.
    <div className="relative overflow-x-clip overflow-y-visible">
      {reveal && (
        <div
          aria-hidden="true"
          className={`absolute inset-0 flex items-center px-4 text-sm font-semibold ${
            reveal === "save" ? "justify-start bg-accent text-badge-text" : "justify-end bg-danger text-badge-text"
          }`}
        >
          {reveal === "save" ? rightLabel : text.remove}
        </div>
      )}
      <div
        data-testid="recent-row"
        className={`relative flex items-stretch bg-surface-raised select-none [-webkit-touch-callout:none] touch-pan-y ${
          dx === 0 ? "transition-transform duration-150 motion-reduce:transition-none" : ""
        }`}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={endGesture}
        onContextMenu={(e) => {
          if (gesture.current || suppressClick.current) e.preventDefault();
        }}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <div className="min-w-0 flex-1">{children}</div>
        <button
          ref={triggerRef}
          type="button"
          data-testid="recent-actions"
          aria-label={text.actions.replace("{label}", label)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 w-11 min-h-11 flex items-center justify-center border-b border-divider text-fg-muted hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          <span aria-hidden="true" className="text-lg leading-none">⋯</span>
        </button>
      </div>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={text.actions.replace("{label}", label)}
          onKeyDown={onMenuKeyDown}
          className="absolute right-2 top-full z-20 -mt-1 min-w-40 rounded-lg border border-divider bg-surface-raised py-1 shadow-2"
        >
          {onRight && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                // Rename moves focus into its field, so only Save refocuses ⋯.
                close(!!onSave);
                onRight();
              }}
              className="block w-full min-h-11 px-4 text-left text-sm text-fg hover:bg-surface-overlay focus:bg-surface-overlay focus:outline-none"
            >
              {rightLabel}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close(false);
              onRemove();
            }}
            className="block w-full min-h-11 px-4 text-left text-sm text-danger hover:bg-surface-overlay focus:bg-surface-overlay focus:outline-none"
          >
            {text.remove}
          </button>
        </div>
      )}
    </div>
  );
}
