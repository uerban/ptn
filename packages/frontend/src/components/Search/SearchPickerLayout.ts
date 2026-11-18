import { createContext, useContext, useEffect, useState } from "react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";

/**
 * "map": choosing a point on the map, which needs the whole screen.
 * "text": typing a place; bottom navigation hides only while the keyboard is up.
 */
export type SearchPickerMode = "map" | "text" | null;

export const SearchPickerLayoutContext = createContext<Dispatch<SetStateAction<SearchPickerMode>>>(() => {});

export function useSearchPickerLayout(mode: SearchPickerMode): void {
  const setPicker = useContext(SearchPickerLayoutContext);
  useEffect(() => {
    setPicker(mode);
    return () => setPicker(null);
  }, [mode, setPicker]);
}

/** A visual viewport this much shorter than the window means an on-screen keyboard. */
const KEYBOARD_MIN_PX = 120;

export function useKeyboardOpen(enabled: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) {
      setOpen(false);
      return;
    }
    const update = () => setOpen(window.innerHeight - viewport.height > KEYBOARD_MIN_PX);
    update();
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, [enabled]);
  return open;
}

/** Track both size and offsets: iOS can pan the visual viewport above its keyboard. */
export function usePickerViewport(enabled: boolean): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useEffect(() => {
    if (!enabled) return;
    const viewport = window.visualViewport;
    const update = () => setStyle({
      position: "fixed",
      top: viewport?.offsetTop ?? 0,
      left: viewport?.offsetLeft ?? 0,
      width: viewport?.width ?? window.innerWidth,
      height: viewport?.height ?? window.innerHeight,
    });
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [enabled]);
  return enabled ? style : undefined;
}
