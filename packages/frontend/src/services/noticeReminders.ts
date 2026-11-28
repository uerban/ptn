import { create } from "zustand";
import { requestNotificationPermission } from "./tripNotifications.ts";

/**
 * Opt-in local reminders for a special trip ("Catch this vehicle"). A timer
 * in the page fires a notification shortly before the first listed trip,
 * while the app is open or installed. Nothing is sent to any server.
 */
export const REMINDER_LEAD_MS = 30 * 60 * 1000;
/** A reminder this far past its time when the app reopens is dropped, not shown late. */
const STALE_MS = 15 * 60 * 1000;
const STORAGE_KEY = "ptn-notice-reminders";
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface NoticeReminder {
  at: number;
  title: string;
  body: string;
}

export const useNoticeReminders = create<{ byId: Record<string, NoticeReminder> }>(() => ({ byId: {} }));

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function remindersSupported(): boolean {
  return typeof Notification !== "undefined" && Notification.permission !== "denied";
}

function save(byId: Record<string, NoticeReminder>): void {
  useNoticeReminders.setState({ byId });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(byId));
  } catch {
    // Storage blocked: the reminder still fires while this page stays open.
  }
}

async function show(id: string, reminder: NoticeReminder): Promise<void> {
  const options = { body: reminder.body, icon: "/pwa-192x192.png", tag: `ptn-notice-${id}` };
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) await registration.showNotification(reminder.title, options);
    else new Notification(reminder.title, options);
  } catch {
    // Revoked or unsupported: a reminder never breaks the app.
  }
}

function schedule(id: string, reminder: NoticeReminder): void {
  clearTimeout(timers.get(id));
  const delay = reminder.at - Date.now();
  // setTimeout overflows past ~24.8 days and would fire at once: hop instead.
  if (delay > MAX_TIMER_MS) {
    timers.set(id, setTimeout(() => schedule(id, reminder), MAX_TIMER_MS));
    return;
  }
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    const { [id]: _done, ...rest } = useNoticeReminders.getState().byId;
    save(rest);
    void show(id, reminder);
  }, Math.max(0, delay)));
}

/** Ask permission (this tap is the only place it is asked) and set the reminder. */
export async function setNoticeReminder(id: string, firstStartMs: number, message: { title: string; body: string }): Promise<boolean> {
  if (!(await requestNotificationPermission())) return false;
  const reminder = { at: firstStartMs - REMINDER_LEAD_MS, ...message };
  save({ ...useNoticeReminders.getState().byId, [id]: reminder });
  schedule(id, reminder);
  return true;
}

export function cancelNoticeReminder(id: string): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const { [id]: _cancelled, ...rest } = useNoticeReminders.getState().byId;
  save(rest);
}

/** Re-arm stored reminders after a reload; never prompts. */
export function restoreNoticeReminders(): void {
  let stored: Record<string, NoticeReminder>;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, NoticeReminder>;
  } catch {
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const now = Date.now();
  const pending = Object.fromEntries(Object.entries(stored).filter(([, r]) => typeof r?.at === "number" && r.at > now - STALE_MS));
  save(pending);
  for (const [id, reminder] of Object.entries(pending)) schedule(id, reminder);
}
