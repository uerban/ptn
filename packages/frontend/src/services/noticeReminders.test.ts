import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelNoticeReminder,
  REMINDER_LEAD_MS,
  remindersSupported,
  restoreNoticeReminders,
  setNoticeReminder,
  useNoticeReminders,
} from "./noticeReminders.ts";

class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => { FakeNotification.permission = "granted"; return "granted"; });
  static shown: string[] = [];
  constructor(title: string) { FakeNotification.shown.push(title); }
}

const MESSAGE = { title: "Line 1G leaves soon", body: "Choir leaves at 18:00." };
const START = Date.parse("2026-12-03T16:00:00Z");

describe("noticeReminders", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-12-03T12:00:00Z") });
    FakeNotification.permission = "default";
    FakeNotification.requestPermission.mockClear();
    FakeNotification.shown = [];
    vi.stubGlobal("Notification", FakeNotification);
    localStorage.clear();
    useNoticeReminders.setState({ byId: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is unsupported without the API or when permission was denied", () => {
    expect(remindersSupported()).toBe(true);
    FakeNotification.permission = "denied";
    expect(remindersSupported()).toBe(false);
    vi.stubGlobal("Notification", undefined);
    expect(remindersSupported()).toBe(false);
  });

  it("asks permission only when set, then fires 30 minutes before the start", async () => {
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(await setNoticeReminder("choir", START, MESSAGE)).toBe(true);
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(useNoticeReminders.getState().byId.choir?.at).toBe(START - REMINDER_LEAD_MS);
    await vi.advanceTimersByTimeAsync(START - REMINDER_LEAD_MS - Date.now() - 1);
    expect(FakeNotification.shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(FakeNotification.shown).toEqual([MESSAGE.title]);
    expect(useNoticeReminders.getState().byId.choir).toBeUndefined();
  });

  it("a refused permission sets nothing", async () => {
    FakeNotification.requestPermission.mockImplementationOnce(async () => "denied");
    expect(await setNoticeReminder("choir", START, MESSAGE)).toBe(false);
    expect(useNoticeReminders.getState().byId).toEqual({});
  });

  it("cancel stops it from firing", async () => {
    await setNoticeReminder("choir", START, MESSAGE);
    cancelNoticeReminder("choir");
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(FakeNotification.shown).toEqual([]);
    expect(useNoticeReminders.getState().byId).toEqual({});
  });

  it("a reload restores pending reminders and drops ones long past", async () => {
    FakeNotification.permission = "granted";
    localStorage.setItem("ptn-notice-reminders", JSON.stringify({
      choir: { at: START - REMINDER_LEAD_MS, ...MESSAGE },
      old: { at: Date.parse("2026-12-01T10:00:00Z"), ...MESSAGE },
    }));
    restoreNoticeReminders();
    expect(Object.keys(useNoticeReminders.getState().byId)).toEqual(["choir"]);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(FakeNotification.shown).toEqual([MESSAGE.title]);
  });
});

describe("noticeReminders far ahead", () => {
  it("a reminder more than 25 days ahead does not fire early", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-01T00:00:00Z") });
    FakeNotification.permission = "granted";
    FakeNotification.shown = [];
    vi.stubGlobal("Notification", FakeNotification);
    await setNoticeReminder("far", Date.parse("2026-12-31T12:00:00Z"), MESSAGE);
    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60 * 1000);
    expect(FakeNotification.shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(31 * 24 * 60 * 60 * 1000);
    expect(FakeNotification.shown).toEqual([MESSAGE.title]);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
