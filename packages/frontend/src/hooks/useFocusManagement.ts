import { useEffect, useCallback, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Traps Tab focus within a container element.
 * When the user tabs past the last focusable element, focus wraps to the first.
 * When the user shift-tabs past the first, focus wraps to the last.
 *
 * Pass `enabled=false` to suspend the trap without unmounting (e.g. when a
 * bottom sheet is collapsed to a peek/half height — only "full" should trap).
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = container!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [containerRef, enabled]);
}

/**
 * Auto-focus the first interactive element inside a container when
 * the specified dependency changes (e.g., new content loads).
 */
export function useAutoFocus(
  ref: RefObject<HTMLElement | null>,
  trigger: unknown,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // If the element itself is focusable (e.g. role="option" with tabindex),
    // focus it directly. Otherwise dive in for the first focusable descendant.
    if (
      el.matches?.(FOCUSABLE_SELECTOR) ||
      el.getAttribute("tabindex") === "0"
    ) {
      el.focus();
      return;
    }
    const first = el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    first?.focus();
  }, [trigger, ref]);
}

/**
 * Captures the document.activeElement on mount and restores focus to it
 * on unmount. Useful for transient overlays (bottom sheets, modals) so
 * focus doesn't get stranded on a hidden element after dismissal.
 */
export function useReturnFocus() {
  const previousElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousElementRef.current = document.activeElement as HTMLElement | null;
    return () => {
      const prev = previousElementRef.current;
      // Only restore if the element is still in the DOM and focusable.
      if (prev && document.contains(prev) && typeof prev.focus === "function") {
        prev.focus();
      }
    };
  }, []);
}

/**
 * Enables arrow-key navigation through a list of focusable items
 * within a container. Items must match FOCUSABLE_SELECTOR.
 *
 * Returns an onKeyDown handler to attach to the container.
 */
export function useArrowKeyNav(containerRef: RefObject<HTMLElement | null>) {
  return useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const container = containerRef.current;
      if (!container) return;

      const items = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (items.length === 0) return;

      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      let nextIndex: number;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
      } else {
        e.preventDefault();
        nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
      }

      items[nextIndex].focus();
    },
    [containerRef],
  );
}
