import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePresentationText } from "../i18n/presentationStrings.ts";
import { mapAssetsCached } from "./mapAssetsCache.ts";
import { findReturnFocus, type TemporaryMap } from "./temporaryMap.ts";

interface DisclosureProps {
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Said at the action, before the first temporary map downloads its files:
 * what is fetched, from where, and that the starting view stays Text mode.
 */
export function MapDownloadDisclosure({ onConfirm, onCancel }: DisclosureProps) {
  const text = usePresentationText();
  const headingId = useId();
  const bodyId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        data-testid="map-download-disclosure"
        className="w-full max-w-md rounded-2xl bg-surface-raised p-4 shadow-2 text-fg"
      >
        <h2 id={headingId} className="text-base font-semibold">
          {text("presentation.mapDisclosureHeading")}
        </h2>
        <p id={bodyId} className="mt-2 text-sm text-fg-secondary">
          {text("presentation.mapDisclosureBody")}
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 px-4 rounded-lg border border-divider text-sm"
          >
            {text("presentation.mapDisclosureCancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="min-h-11 px-4 rounded-lg bg-primary text-white text-sm font-semibold"
          >
            {text("presentation.mapDisclosureConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ShowMapAction {
  /** Open the temporary map; `returnFocus` names the opener (`data-return-focus`). */
  request: (returnFocus: string) => void;
  /** The download disclosure while it is open, else null. */
  disclosure: ReactNode;
}

/**
 * **Show map** from Text mode: opens the temporary map at once when its files
 * are already on this device, else asks first (the files are not part of the
 * Text mode download).
 */
export function useShowMapAction(
  temporaryMap: TemporaryMap,
  isCached: () => Promise<boolean> = mapAssetsCached,
): ShowMapAction {
  const [pending, setPending] = useState<string | null>(null);
  const { open } = temporaryMap;

  const request = useCallback(
    (returnFocus: string) => {
      void isCached().then((cached) => {
        if (cached) open(returnFocus);
        else setPending(returnFocus);
      });
    },
    [isCached, open],
  );

  const confirm = useCallback(() => {
    const target = pending;
    setPending(null);
    open(target ?? undefined);
  }, [pending, open]);

  const cancel = useCallback(() => {
    const target = pending;
    setPending(null);
    if (target) findReturnFocus(target)?.focus();
  }, [pending]);

  return {
    request,
    disclosure:
      pending !== null ? <MapDownloadDisclosure onConfirm={confirm} onCancel={cancel} /> : null,
  };
}
