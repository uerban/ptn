import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveLocationController } from "./liveLocation.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";

const fix = (lat = 54.6872): GeolocationPosition => ({
  coords: { latitude: lat, longitude: 25.2797, accuracy: 5, speed: 4, heading: 90 },
  timestamp: Date.now(),
} as GeolocationPosition);

describe("shared foreground location", () => {
  let location: LiveLocationController;
  let permission: EventTarget & { state: PermissionState };
  let success: PositionCallback;
  let failure: PositionErrorCallback;
  let watch: ReturnType<typeof vi.fn>;
  let clear: ReturnType<typeof vi.fn>;
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    useSettingsStore.getState().setGpsMode("enabled");
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    permission = Object.assign(new EventTarget(), { state: "granted" as PermissionState });
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn(async () => permission) },
      geolocation: {
        watchPosition: watch = vi.fn((onSuccess, onError) => {
          success = onSuccess;
          failure = onError;
          return 42;
        }),
        clearWatch: clear = vi.fn(),
      },
    });
    location = new LiveLocationController();
  });

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function subscribe() {
    const off = location.subscribe(vi.fn());
    cleanups.push(off);
    await Promise.resolve();
    return off;
  }

  it("starts without a locate tap when preapproved and shares one watch across consumers", async () => {
    await subscribe();
    await subscribe();
    expect(watch).toHaveBeenCalledTimes(1);
    success(fix());
    expect(location.getSnapshot()).toMatchObject({
      position: { lat: 54.6872, lon: 25.2797 }, speed: 4, accuracy: 5, loading: false,
    });
    location.request();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(location.getSnapshot().position).not.toBeNull();
  });

  it("does not prompt on opening, but navigation may request permission", async () => {
    permission.state = "prompt";
    await subscribe();
    expect(watch).not.toHaveBeenCalled();
    location.request("navigation");
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("supports explicit location and foreground resume when Safari cannot query permissions", async () => {
    vi.mocked(navigator.permissions.query).mockRejectedValue(new TypeError("unsupported"));
    await subscribe();
    expect(watch).not.toHaveBeenCalled();
    location.request();
    success(fix());
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clear).toHaveBeenCalledWith(42);
    expect(location.getSnapshot().position).toBeNull();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when paused, ignores late fixes, and only Locate me reenables", async () => {
    await subscribe();
    success(fix());
    const lateFix = success;
    useSettingsStore.getState().setGpsMode("until-locate");
    expect(clear).toHaveBeenCalledWith(42);
    lateFix(fix(55));
    expect(location.getSnapshot().position).toBeNull();
    expect(location.request("navigation")).toBe(false);
    expect(location.request("startup")).toBe(false);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(location.request()).toBe(true);
    expect(useSettingsStore.getState().gpsMode).toBe("enabled");
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("hard off blocks every request and does not start a watch after reload", async () => {
    useSettingsStore.getState().setGpsMode("disabled");
    await subscribe();
    for (const source of ["locate", "search", "navigation", "startup"] as const) {
      expect(location.request(source)).toBe(false);
    }
    expect(watch).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().gpsMode).toBe("disabled");
  });

  it("stops on permission revocation and can resume after granting again", async () => {
    await subscribe();
    success(fix());
    permission.state = "denied";
    permission.dispatchEvent(new Event("change"));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(location.getSnapshot().position).toBeNull();
    permission.state = "granted";
    permission.dispatchEvent(new Event("change"));
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("stops and clears the fix on permission denial from the device", async () => {
    await subscribe();
    success(fix());
    failure({ code: 1, message: "Denied" } as GeolocationPositionError);
    expect(clear).toHaveBeenCalledWith(42);
    expect(location.getSnapshot()).toMatchObject({ position: null, error: "Denied", loading: false });
  });

  it("handles iOS page cache lifecycle and discards callbacks from the old watch", async () => {
    await subscribe();
    const oldSuccess = success;
    window.dispatchEvent(new Event("pagehide"));
    oldSuccess(fix());
    expect(location.getSnapshot().position).toBeNull();
    window.dispatchEvent(new Event("pageshow"));
    await Promise.resolve();
    expect(watch).toHaveBeenCalledTimes(2);
    success(fix(55));
    oldSuccess(fix(54));
    expect(location.getSnapshot().position?.lat).toBe(55);
  });

  it("cannot restart from a late permission query after pagehide", async () => {
    let resolve!: (value: PermissionStatus) => void;
    vi.mocked(navigator.permissions.query).mockReturnValue(new Promise((done) => { resolve = done; }));
    cleanups.push(location.subscribe(vi.fn()));
    window.dispatchEvent(new Event("pagehide"));
    resolve(permission as PermissionStatus);
    await Promise.resolve();
    expect(watch).not.toHaveBeenCalled();
  });

  it("retries a failed watch on an explicit tap without overlapping watches", async () => {
    await subscribe();
    failure({ code: 3, message: "Timeout" } as GeolocationPositionError);
    location.request();
    expect(clear).toHaveBeenCalledWith(42);
    expect(watch).toHaveBeenCalledTimes(2);
    success(fix());
    expect(location.getSnapshot()).toMatchObject({ loading: false, error: null });
  });

  it("does not restart an initial pending fix on repeated taps", async () => {
    await subscribe();
    location.request();
    location.request();
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("cleans up only when the last subscriber leaves", async () => {
    const off1 = await subscribe();
    const off2 = await subscribe();
    off1();
    expect(clear).not.toHaveBeenCalled();
    off2();
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it("pause keeps the last fix, stops the watch, and survives backgrounding", async () => {
    await subscribe();
    success(fix());
    location.pause();
    expect(clear).toHaveBeenCalledWith(42);
    expect(location.getSnapshot()).toMatchObject({ paused: true, position: { lat: 54.6872 } });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve(); await Promise.resolve();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(location.getSnapshot()).toMatchObject({ paused: true, position: { lat: 54.6872 } });
  });

  it("resume, Locate me, and navigation each restart a paused watch", async () => {
    await subscribe();
    success(fix());
    location.pause();
    location.resume();
    await Promise.resolve(); await Promise.resolve();
    expect(watch).toHaveBeenCalledTimes(2);
    expect(location.getSnapshot().paused).toBe(false);
    for (const source of ["locate", "navigation"] as const) {
      location.pause();
      expect(location.request(source)).toBe(true);
      expect(location.getSnapshot().paused).toBe(false);
    }
    expect(watch).toHaveBeenCalledTimes(4);
  });

  it("does not pause outside the automatic GPS mode", async () => {
    await subscribe();
    useSettingsStore.getState().setGpsMode("until-locate");
    location.pause();
    expect(location.getSnapshot().paused).toBe(false);
  });
  it("counts explicit requests but not passive fixes", async () => {
    await subscribe();
    success(fix());
    success(fix(54.69));
    expect(location.getSnapshot().requestId).toBe(0);
    location.request("locate");
    success(fix(54.7));
    expect(location.getSnapshot().requestId).toBe(1);
    useSettingsStore.getState().setGpsMode("disabled");
    expect(location.request("locate")).toBe(false);
    expect(location.getSnapshot().requestId).toBe(1);
  });
});
