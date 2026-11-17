import { useEffect, useRef, useState, type ReactNode } from "react";

const FADE = "1.5rem";

/**
 * Horizontal scroller that fades an edge only while more content is hidden
 * past it, so a cut-off chip reads as "scroll for more". Below 360 px the
 * content wraps instead (the caller's flex row wraps there too).
 */
export function ScrollFade({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const start = el.scrollLeft > 1;
      const end = max - el.scrollLeft > 1;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);

  const mask = edges.start || edges.end
    ? `linear-gradient(to right, ${edges.start ? "transparent" : "black"}, black ${FADE}, black calc(100% - ${FADE}), ${edges.end ? "transparent" : "black"})`
    : undefined;

  return (
    <div
      ref={ref}
      data-testid="scroll-fade"
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
      className="min-w-0 flex-1 overflow-x-auto max-[359px]:overflow-visible max-[359px]:basis-full"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {children}
    </div>
  );
}
