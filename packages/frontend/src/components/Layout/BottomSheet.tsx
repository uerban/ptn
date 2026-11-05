import { useEffect, useRef, type ReactNode } from "react";
import {
  useFocusTrap,
  useReturnFocus,
} from "../../hooks/useFocusManagement.ts";

export type SheetHeight = "peek" | "half" | "full";

interface BottomSheetProps {
  /** Sheet contents. */
  children: ReactNode;
  /** Called when Escape is pressed or backdrop is clicked. */
  onClose: () => void;
  /** Optional aria-label for the sheet (announced by screen readers). */
  ariaLabel?: string;
  /**
   * Current sheet height. Focus trap activates only at "full" so peek/half
   * leaves the rest of the page operable for keyboard users.
   */
  height?: SheetHeight;
  /** Test id for integration tests. */
  "data-testid"?: string;
  /** Additional class names appended to the sheet container. */
  className?: string;
}

/**
 * Generic bottom-sheet shell with keyboard-only navigation primitives:
 *   - Escape closes the sheet
 *   - On open: focus moves into the sheet (first interactive element)
 *   - On close: focus returns to whatever element triggered the sheet
 *   - When height === "full", Tab is trapped within the sheet so screen-reader
 *     users can't accidentally land on map elements behind a fullscreen sheet
 *
 * Stylistically opaque — consumers control look-and-feel via children. The
 * height prop only governs keyboard semantics, not visuals.
 */
export function BottomSheet({
  children,
  onClose,
  ariaLabel,
  height = "half",
  "data-testid": testId,
  className,
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);

  // Capture the activeElement on mount, restore on unmount.
  useReturnFocus();

  // Focus trap only at full height — peek/half should not trap keyboard.
  useFocusTrap(sheetRef, height === "full");

  // Escape closes the sheet (document-level so focus can be anywhere).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Move focus into the sheet on mount: prefer the close button if labelled,
  // otherwise the first focusable descendant.
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const closeBtn = el.querySelector<HTMLElement>("[data-sheet-close]");
    if (closeBtn) {
      closeBtn.focus();
      return;
    }
    const first = el.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  }, []);

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-modal={height === "full" ? true : undefined}
      aria-label={ariaLabel}
      data-testid={testId}
      data-sheet-height={height}
      className={className}
    >
      {children}
    </div>
  );
}
