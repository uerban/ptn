import type { BuildInfo } from "@pt/shared";

export const buildInfo: BuildInfo = {
  version: __BUILD_VERSION__,
  commit: __BUILD_COMMIT__,
  builtAt: __BUILD_AT__,
};
