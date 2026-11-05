import js from "@eslint/js";
import tseslint from "typescript-eslint";
import noDirectPrivacyLevelRead from "./eslint-rules/no-direct-privacy-level-read.js";
import noDynamicErrorboundaryContext from "./eslint-rules/no-dynamic-errorboundary-context.js";
import noRawCoarsenCast from "./eslint-rules/no-raw-coarsen-cast.js";

const ptnLocal = {
  rules: {
    "no-direct-privacy-level-read": noDirectPrivacyLevelRead,
    "no-dynamic-errorboundary-context": noDynamicErrorboundaryContext,
    "no-raw-coarsen-cast": noRawCoarsenCast,
  },
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/"],
  },
  {
    plugins: {
      "ptn-local": ptnLocal,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "ptn-local/no-direct-privacy-level-read": "error",
      "ptn-local/no-dynamic-errorboundary-context": "error",
      "ptn-local/no-raw-coarsen-cast": "error",
    },
  },
);
