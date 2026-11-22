export type BuildInfo = {
  /** Application version from scripts/app-version.mjs, e.g. "0.2.44" for a
   * main build (patch = main first-parent commits since major.minor was set),
   * "0.2.44-dev+0459991f" for other commits, "0.2.0-dev" without history. */
  version: string;
  /** Short commit SHA, e.g. "abcd123". Suffixed with "-dirty" if the
   * working copy had uncommitted changes at build time, or the literal
   * "unknown" if git was unavailable. */
  commit: string;
  /** ISO 8601 UTC timestamp captured at build time, e.g.
   * "2026-05-04T18:23:11.000Z". */
  builtAt: string;
};
