import { useSettingsStore } from "../stores/settingsStore.ts";
import type { LatLon } from "@pt/shared";

export interface LiveLocation {
  position: LatLon | null;
  speed: number | null;
  heading: number | null;
  accuracy: number | null;
  timestamp: number | null;
  loading: boolean;
  error: string | null;
  /** Session-only pause: the last fix is kept but no longer updates. */
  paused: boolean;
  /** Bumped on each explicit request (Locate me, search, navigation, opted-in
   * startup locate). Server lookups may follow these, never passive updates. */
  requestId: number;
}
const EMPTY: LiveLocation = {
  position: null, speed: null, heading: null, accuracy: null,
  timestamp: null, loading: false, error: null, paused: false, requestId: 0,
};

/** One foreground watch shared by the map, search, and navigation.
 * Coordinates remain in memory. Hidden documents cannot depend on GPS updates:
 * https://www.w3.org/TR/geolocation/#request-a-position
 */
export class LiveLocationController {
  private state = EMPTY;
  private listeners = new Set<() => void>();
  private watchId: number | null = null;
  private generation = 0;
  private permission: PermissionStatus | null = null;
  private permissionCleanup?: () => void;
  private settingsCleanup?: () => void;
  private explicitConsent = false;
  private active = false;
  private suspended = false;
  private permissionQuery = 0;
  private paused = false;

  getSnapshot = (): LiveLocation => this.state;
  private publish(next: LiveLocation) {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.active) this.activate();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.deactivate();
    };
  };

  private activate() {
    this.active = true;
    this.suspended = document.visibilityState === "hidden";
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pageshow", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    this.settingsCleanup = useSettingsStore.subscribe((state, previous) => {
      if (state.gpsMode === previous.gpsMode) return;
      if (state.gpsMode !== "enabled") {
        this.explicitConsent = false;
        this.paused = false;
        this.stop(true);
      } else {
        void this.checkPermission();
      }
    });
    void this.checkPermission();
  }

  private deactivate() {
    this.active = false;
    ++this.permissionQuery;
    this.stop(true);
    this.permissionCleanup?.();
    this.permissionCleanup = undefined;
    this.permission = null;
    this.settingsCleanup?.();
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pageshow", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
  }

  private onPageHide = () => {
    this.suspended = true;
    this.stop(!this.paused); // A paused fix stays as the nearby-stops anchor.
  };
  private onVisibility = () => {
    this.suspended = document.visibilityState === "hidden";
    if (this.suspended) this.stop(!this.paused);
    else void this.checkPermission();
  };

  private async checkPermission() {
    if (!this.active || useSettingsStore.getState().gpsMode !== "enabled") return;
    const query = ++this.permissionQuery;
    // Older Safari can lack (or reject) geolocation permission queries. Never
    // infer permission from that failure; an explicit tap still works there.
    try {
      const permission = await navigator.permissions.query({ name: "geolocation" });
      if (!this.active || query !== this.permissionQuery || useSettingsStore.getState().gpsMode !== "enabled") return;
      this.permissionCleanup?.();
      this.permission = permission;
      const onChange = () => {
        if (permission.state !== "granted") {
          this.explicitConsent = false;
          this.stop(true);
        } else if (permission.state === "granted") this.start();
      };
      permission.addEventListener("change", onChange);
      this.permissionCleanup = () => permission.removeEventListener("change", onChange);
    } catch {
      // Explicit consent remains valid for this session on older Safari.
    }
    if (query !== this.permissionQuery || !this.active) return;
    if (this.permission?.state === "denied") {
      this.explicitConsent = false;
      this.stop(true);
    } else if (this.permission?.state === "granted" || this.explicitConsent) this.start();
  }

  /** Stop the device watch but keep the last fix (muted) so nearby stops stay put.
   * Not persisted: a reload, Locate me, or navigation resumes tracking. */
  pause = () => {
    if (this.paused || useSettingsStore.getState().gpsMode !== "enabled") return;
    this.paused = true;
    this.stop(false);
    this.publish({ ...this.state, loading: false, error: null, paused: true });
  };

  resume = () => {
    if (!this.paused) return;
    this.paused = false;
    this.publish({ ...this.state, paused: false });
    void this.checkPermission();
  };

  /** Only Locate me may lift the temporary off setting. Hard off always wins. */
  request = (source: "locate" | "navigation" | "search" | "startup" = "locate"): boolean => {
    const { gpsMode, setGpsMode } = useSettingsStore.getState();
    if (gpsMode === "disabled" || (gpsMode === "until-locate" && source !== "locate")) return false;
    if (gpsMode === "until-locate") setGpsMode("enabled");
    this.explicitConsent = true;
    this.paused = false;
    this.publish({ ...this.state, paused: false, requestId: this.state.requestId + 1 });
    // A failed or stale watch can be restarted explicitly. Ordinary recenter
    // taps consume the current fix without issuing another device request.
    if (this.watchId !== null && (this.state.error || (this.state.timestamp !== null &&
        Date.now() - this.state.timestamp > 30_000))) this.stop(false);
    this.start();
    return true;
  };

  private start() {
    if (!this.active || this.suspended || this.paused || this.watchId !== null || document.visibilityState === "hidden" ||
        useSettingsStore.getState().gpsMode !== "enabled") return;
    if (!navigator.geolocation) {
      this.publish({ ...EMPTY, error: "Geolocation is not supported" });
      return;
    }
    const generation = ++this.generation;
    this.publish({ ...this.state, loading: true, error: null });
    this.watchId = navigator.geolocation.watchPosition((position) => {
      if (generation !== this.generation) return;
      this.explicitConsent = true;
      this.publish({
        position: { lat: position.coords.latitude, lon: position.coords.longitude },
        accuracy: position.coords.accuracy, speed: position.coords.speed,
        heading: position.coords.heading, timestamp: position.timestamp,
        loading: false, error: null, paused: false, requestId: this.state.requestId,
      });
    }, (error) => {
      if (generation !== this.generation) return;
      if (error.code === 1) {
        this.explicitConsent = false;
        this.stop(true);
      }
      this.publish({ ...this.state, loading: false, error: error.message });
    }, { enableHighAccuracy: true, maximumAge: 3_000, timeout: 10_000 });
  }

  private stop(clear: boolean) {
    ++this.generation; // Ignore in-flight fixes after disabling GPS or hiding.
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    if (clear) this.publish({ ...EMPTY, paused: this.paused, requestId: this.state.requestId });
  }
}

export const liveLocation = new LiveLocationController();
