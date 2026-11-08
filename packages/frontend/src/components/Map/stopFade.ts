import type { StopWithLines } from "@pt/shared";

export const STOP_FADE_MS = 200;

interface FadeHost {
  prepareVisibility?: () => void;
  onscreen: (stop: StopWithLines) => boolean;
  reducedMotion: () => boolean;
  opacity: (id: string, opacity: number, exiting: boolean) => void;
  changed: () => void;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
}

interface CityFadeContext {cityId: string; generation: string | null}
function isCityContext(value: unknown): value is CityFadeContext {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<CityFadeContext>;
  return typeof context.cityId === "string" && (context.generation === null || typeof context.generation === "string");
}
function continuesContext(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  // First qualification of the same city's pending names is not a feed
  // replacement: let their authoritative inactive verdict start a fade.
  return isCityContext(previous) && isCityContext(next) && previous.cityId === next.cityId &&
    (previous.generation === null || previous.generation === next.generation);
}

/** Presentation-only exits. Never insert these snapshots into application data. */
export class StopFade {
  readonly exiting = new Map<string, { stop: StopWithLines; started: number }>();
  private previous = new Map<string, StopWithLines>();
  private context: unknown;
  private frame: number | undefined;

  constructor(private readonly host: FadeHost) {}

  reconcile(stops: StopWithLines[], catalog: StopWithLines[], context: unknown, now: number): void {
    this.host.prepareVisibility?.();
    const active = new Map(stops.map(stop => [stop.id, stop]));
    const eligible = new Set(catalog.map(stop => stop.id));
    const reducedMotion = this.host.reducedMotion();
    const sameContext = continuesContext(this.context, context);
    for (const [id, exit] of this.exiting) {
      if (!sameContext || active.has(id) || !eligible.has(id) || reducedMotion || !this.host.onscreen(exit.stop)) {
        this.exiting.delete(id);
        this.host.opacity(id, active.has(id) ? 1 : 0, !active.has(id));
      }
    }
    if (sameContext && !reducedMotion) {
      for (const [id, stop] of this.previous) {
        if (!active.has(id) && eligible.has(id) && !this.exiting.has(id) && this.host.onscreen(stop)) {
          this.exiting.set(id, { stop, started: now });
          // Disable interaction before the first animation frame.
          this.host.opacity(id, 1, true);
        }
      }
    }
    for (const id of active.keys()) {
      if (!this.previous.has(id)) this.host.opacity(id, 1, false);
    }
    this.previous = active;
    this.context = context;
    if (this.exiting.size && this.frame === undefined) this.frame = this.host.requestFrame(this.tick);
    if (!this.exiting.size && this.frame !== undefined) {
      this.host.cancelFrame(this.frame);
      this.frame = undefined;
    }
  }

  private tick = (now: number): void => {
    this.frame = undefined;
    this.host.prepareVisibility?.();
    let changed = false;
    for (const [id, exit] of this.exiting) {
      const opacity = this.host.reducedMotion() || !this.host.onscreen(exit.stop)
        ? 0 : Math.max(0, Math.min(1, 1 - (now - exit.started) / STOP_FADE_MS));
      this.host.opacity(id, opacity, true);
      if (opacity === 0) { this.exiting.delete(id); changed = true; }
    }
    if (changed) this.host.changed();
    if (this.exiting.size) this.frame = this.host.requestFrame(this.tick);
  };

  dispose(): void {
    if (this.frame !== undefined) this.host.cancelFrame(this.frame);
    this.frame = undefined;
    this.exiting.clear();
    this.previous.clear();
    this.context = undefined;
  }
}
