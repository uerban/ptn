import { useEffect, useRef } from "react";

/** How long Undo stays offered before a removal is final. */
export const UNDO_WINDOW_MS = 4000;
const SAVED_VISIBLE_MS = 2000;

export type RecentNoticeState =
  | { kind: "saved"; label: string }
  | { kind: "removed"; label: string; commit: () => void; undo: () => void };

export interface RecentNoticeProps {
  notice: RecentNoticeState;
  onDone: () => void;
  text: { saved: string; removed: string; undo: string };
}

/**
 * Confirms a recent's Save or Remove. A removal is only made final when the
 * Undo window ends, the notice is replaced, or the page closes.
 */
export function RecentNotice({ notice, onDone, text }: RecentNoticeProps) {
  const undoRef = useRef<HTMLButtonElement>(null);
  const settled = useRef(false);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    settled.current = false;
    if (notice.kind === "removed") undoRef.current?.focus();
    const timer = setTimeout(
      () => {
        if (notice.kind === "removed" && !settled.current) {
          settled.current = true;
          notice.commit();
        }
        onDoneRef.current();
      },
      notice.kind === "removed" ? UNDO_WINDOW_MS : SAVED_VISIBLE_MS,
    );
    return () => {
      clearTimeout(timer);
      if (notice.kind === "removed" && !settled.current) {
        settled.current = true;
        notice.commit();
      }
    };
  }, [notice]);

  const message = (notice.kind === "saved" ? text.saved : text.removed).replace("{label}", notice.label);

  return (
    <div
      data-testid="recent-notice"
      className="flex min-h-11 items-center justify-between gap-3 border-b border-divider bg-surface-overlay px-4 py-1 text-sm text-fg"
    >
      <span role="status" className="min-w-0">{message}</span>
      {notice.kind === "removed" && (
        <button
          ref={undoRef}
          type="button"
          onClick={() => {
            settled.current = true;
            notice.undo();
            onDone();
          }}
          className="shrink-0 min-h-11 px-2 font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          {text.undo}
        </button>
      )}
    </div>
  );
}
