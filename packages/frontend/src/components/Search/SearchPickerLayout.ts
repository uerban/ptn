import { createContext, useContext, useEffect, useState } from "react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";

export const SearchPickerLayoutContext = createContext<Dispatch<SetStateAction<boolean>>>(() => {});

export function useSearchPickerLayout(enabled: boolean): void {
  const setPicker = useContext(SearchPickerLayoutContext);
  useEffect(() => {
    setPicker(enabled);
    return () => setPicker(false);
  }, [enabled, setPicker]);
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
