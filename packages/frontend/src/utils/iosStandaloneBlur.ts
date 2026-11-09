// iOS 27 home-screen web apps launch with a blurred band across the top of the
// screen (portrait only). It clears after the first scroll of the document and
// stays clear until the app is relaunched. The app shell never scrolls the
// document (#root is 100dvh), so nudge it once: grow the page by a pixel,
// scroll by one, then restore. Reports:
// https://forums.macrumors.com/threads/ios-27-pwa-blurred-across-top-of-screen.2489325/

interface Env {
  navigator: Pick<Navigator, "userAgent" | "maxTouchPoints"> & {standalone?: boolean};
  matchMedia: (query: string) => {matches: boolean};
}

export function isIosStandalone(env: Env): boolean {
  const ua = env.navigator.userAgent;
  // iPadOS reports a Mac user agent; touch support tells it apart.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.navigator.maxTouchPoints > 1);
  if (!ios) return false;
  return env.navigator.standalone === true || env.matchMedia("(display-mode: standalone)").matches;
}

export function nudgeDocumentScroll(doc: Document = document, win: Window = window): void {
  const spacer = doc.createElement("div");
  spacer.setAttribute("aria-hidden", "true");
  spacer.style.cssText = "height:1px;width:1px;pointer-events:none;";
  const html = doc.documentElement;
  const previousOverflow = html.style.overflowY;
  html.style.overflowY = "auto";
  doc.body.append(spacer);
  win.requestAnimationFrame(() => {
    win.scrollTo(0, 1);
    win.requestAnimationFrame(() => {
      win.scrollTo(0, 0);
      spacer.remove();
      html.style.overflowY = previousOverflow;
    });
  });
}

export function applyIosStandaloneBlurWorkaround(win: Window = window): void {
  if (!isIosStandalone(win as unknown as Env)) return;
  const run = () => nudgeDocumentScroll(win.document, win);
  if (win.document.readyState === "complete") run();
  else win.addEventListener("load", run, {once: true});
  // A relaunch restored from memory reuses the page; nudge again.
  win.addEventListener("pageshow", event => {
    if ((event as PageTransitionEvent).persisted) run();
  });
}
