export type BuildInfo = {
  /** Display version, e.g. "0.1.247". major.minor from the package's
   * package.json; patch is `git rev-list --count HEAD`. */
  version: string;
  /** Short commit SHA, e.g. "abcd123". Suffixed with "-dirty" if the
   * working copy had uncommitted changes at build time, or the literal
   * "unknown" if git was unavailable. */
  commit: string;
  /** ISO 8601 UTC timestamp captured at build time, e.g.
   * "2026-05-04T18:23:11.000Z". */
  builtAt: string;
};
