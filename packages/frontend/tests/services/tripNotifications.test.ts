import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  notifyIfBackground,
  requestNotificationPermission,
} from "../../src/services/tripNotifications.ts";

describe("tripNotifications", () => {
  let NotificationMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    NotificationMock = vi.fn();
    NotificationMock.permission = "granted";
    NotificationMock.requestPermission = vi.fn().mockResolvedValue("granted");
    (globalThis as any).Notification = NotificationMock;
    Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    delete (globalThis as any).Notification;
  });

  describe("notifyIfBackground", () => {
    it("sends notification when document is hidden and permission is granted", async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        writable: true,
        configurable: true,
      });

      const result = await notifyIfBackground("Title", "Body text");

      expect(result).toBe(true);
      expect(NotificationMock).toHaveBeenCalledWith("Title", {
        body: "Body text",
        icon: "/pwa-192x192.png",
        tag: "ptn-trip",
      });
    });

    it("does NOT send notification when document is visible", async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        writable: true,
        configurable: true,
      });

      const result = await notifyIfBackground("Title", "Body text");

      expect(result).toBe(false);
      expect(NotificationMock).not.toHaveBeenCalled();
    });

    it("does NOT send notification when permission is denied", async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        writable: true,
        configurable: true,
      });
      NotificationMock.permission = "denied";

      const result = await notifyIfBackground("Title", "Body text");

      expect(result).toBe(false);
      expect(NotificationMock).not.toHaveBeenCalled();
    });

    it("does NOT send notification when permission is default (not yet requested)", async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        writable: true,
        configurable: true,
      });
      NotificationMock.permission = "default";

      const result = await notifyIfBackground("Title", "Body text");

      expect(result).toBe(false);
      expect(NotificationMock).not.toHaveBeenCalled();
    });

    it("does NOT throw when Notification is undefined", async () => {
      delete (globalThis as any).Notification;
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        writable: true,
        configurable: true,
      });

      const result = await notifyIfBackground("Title", "Body text");

      expect(result).toBe(false);
    });
  });

  it("uses service-worker notifications on Android and iOS without constructing Notification", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const showNotification = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "serviceWorker", { value: {
      getRegistration: vi.fn().mockResolvedValue({ showNotification }),
    }, configurable: true });
    expect(await notifyIfBackground("Next stop", "Get off here")).toBe(true);
    expect(showNotification).toHaveBeenCalledWith("Next stop", expect.objectContaining({ body: "Get off here" }));
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it("catches unsupported mobile constructors and worker failures", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    NotificationMock.mockImplementation(() => { throw new TypeError("Illegal constructor"); });
    expect(await notifyIfBackground("Next stop", "Get off here")).toBe(false);
    Object.defineProperty(navigator, "serviceWorker", { value: {
      getRegistration: vi.fn().mockRejectedValue(new Error("worker failed")),
    }, configurable: true });
    expect(await notifyIfBackground("Next stop", "Get off here")).toBe(false);
  });

  describe("requestNotificationPermission", () => {
    it("returns true when permission is already granted", async () => {
      NotificationMock.permission = "granted";

      const result = await requestNotificationPermission();

      expect(result).toBe(true);
      expect(NotificationMock.requestPermission).not.toHaveBeenCalled();
    });

    it("returns false when permission is denied", async () => {
      NotificationMock.permission = "denied";

      const result = await requestNotificationPermission();

      expect(result).toBe(false);
      expect(NotificationMock.requestPermission).not.toHaveBeenCalled();
    });

    it("requests permission when status is default", async () => {
      NotificationMock.permission = "default";
      NotificationMock.requestPermission.mockResolvedValue("granted");

      const result = await requestNotificationPermission();

      expect(result).toBe(true);
      expect(NotificationMock.requestPermission).toHaveBeenCalled();
    });

    it("returns false when user denies permission request", async () => {
      NotificationMock.permission = "default";
      NotificationMock.requestPermission.mockResolvedValue("denied");

      const result = await requestNotificationPermission();

      expect(result).toBe(false);
    });

    it("returns false when Notification API is unavailable", async () => {
      delete (globalThis as any).Notification;

      const result = await requestNotificationPermission();

      expect(result).toBe(false);
    });
  });
});
