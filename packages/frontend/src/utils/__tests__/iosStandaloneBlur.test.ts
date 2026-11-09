import {describe, expect, it, vi} from "vitest";
import {isIosStandalone, nudgeDocumentScroll} from "../iosStandaloneBlur";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15";

function env(userAgent: string, opts: {standalone?: boolean; displayMode?: boolean; touch?: number} = {}) {
  return {
    navigator: {userAgent, maxTouchPoints: opts.touch ?? 0, standalone: opts.standalone},
    matchMedia: () => ({matches: opts.displayMode ?? false}),
  };
}

describe("isIosStandalone", () => {
  it("is true for a home-screen launch on iPhone", () => {
    expect(isIosStandalone(env(IPHONE, {standalone: true}))).toBe(true);
    expect(isIosStandalone(env(IPHONE, {displayMode: true}))).toBe(true);
  });
  it("is false in Safari tabs", () => {
    expect(isIosStandalone(env(IPHONE))).toBe(false);
  });
  it("treats a touch Mac user agent as iPadOS", () => {
    expect(isIosStandalone(env(MAC, {standalone: true, touch: 5}))).toBe(true);
    expect(isIosStandalone(env(MAC, {standalone: true}))).toBe(false);
  });
  it("is false for installed apps on other platforms", () => {
    expect(isIosStandalone(env("Mozilla/5.0 (Linux; Android 15)", {displayMode: true}))).toBe(false);
  });
});

describe("nudgeDocumentScroll", () => {
  it("scrolls by one pixel and back, then restores the page", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(cb => (frames.push(cb), frames.length));
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    document.documentElement.style.overflowY = "hidden";
    const children = document.body.childElementCount;

    nudgeDocumentScroll();
    expect(document.body.childElementCount).toBe(children + 1);
    frames.shift()!(0);
    frames.shift()!(0);

    expect(scrollTo.mock.calls).toEqual([[0, 1], [0, 0]]);
    expect(document.body.childElementCount).toBe(children);
    expect(document.documentElement.style.overflowY).toBe("hidden");
    vi.restoreAllMocks();
  });
});
