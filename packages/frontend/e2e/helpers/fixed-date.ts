import { type Page } from "@playwright/test";

/**
 * Pin wall-clock Date without Playwright's full clock shim. `page.clock` also
 * replaces the Performance API with no-op mark/measure methods, which makes it
 * unsuitable for the wasm cold-start budget suite.
 */
export async function setFixedDate(page: Page, value: Date): Promise<void> {
  await page.addInitScript(({ now }) => {
    const NativeDate = Date;

    function FixedDate(this: Date, ...args: unknown[]): string | Date {
      if (!new.target) return new NativeDate(now).toString();
      return Reflect.construct(
        NativeDate,
        args.length === 0 ? [now] : args,
        new.target,
      ) as Date;
    }

    Object.setPrototypeOf(FixedDate, NativeDate);
    FixedDate.prototype = NativeDate.prototype;
    Object.defineProperty(FixedDate, "now", { value: () => now });
    globalThis.Date = FixedDate as unknown as DateConstructor;
  }, { now: value.getTime() });
}
