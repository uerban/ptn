import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "./no-direct-privacy-level-read.js";

// Drive RuleTester scenarios from within vitest's `it` callback. Vitest
// rejects nested `describe`/`it` calls made during a test body (RuleTester's
// default behaviour; Vitest 3 silently dropped them, so the scenarios never
// asserted). Routing them through synchronous wrappers makes RuleTester throw
// on failure inside the surrounding `it`, which vitest then surfaces.
RuleTester.describe = function (_text, method) {
  return method.call(this);
};
RuleTester.it = function (_text, method) {
  return method.call(this);
};

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("no-direct-privacy-level-read", () => {
  it("runs the rule tester scenarios", () => {
    ruleTester.run("no-direct-privacy-level-read", rule, {
      valid: [
        // Reading level inside the privacy store module itself is fine.
        {
          code: "const { level } = usePrivacyStore.getState();",
          filename: "/abs/src/stores/privacyStore.ts",
        },
        {
          code: "const l = usePrivacyStore((s) => s.level);",
          filename: "/abs/src/stores/privacyStore.ts",
        },
        // Unit test for the store can also inspect state directly.
        {
          code: "expect(usePrivacyStore.getState().level).toBe('standard');",
          filename: "/abs/src/stores/privacyStore.test.ts",
        },
        // Using the policy hook in a component is the approved path.
        { code: "const policy = usePolicy(); const e = policy.errorReporting;" },
        // Unrelated `.level` access should not trip the rule.
        { code: "const l = nesting.level;" },
        // `.level` on non-store identifier is fine.
        { code: "const l = settingsStore.level;" },
        // Unrelated `.privacyLevel`-looking identifiers (computed) don't match.
        { code: "const key = 'privacyLevel'; const v = obj[key];" },
      ],
      invalid: [
        {
          code: "const l = privacyStore.level;",
          errors: [{ messageId: "direct" }],
        },
        {
          code: "const l = privacyState.level;",
          errors: [{ messageId: "direct" }],
        },
        {
          code: "const l = usePrivacyStore.getState().level;",
          errors: [{ messageId: "direct" }],
        },
        {
          code: "const v = settings.privacyLevel;",
          errors: [{ messageId: "direct" }],
        },
        {
          code: "if (state.privacyLevel === 'paranoid') {}",
          errors: [{ messageId: "direct" }],
        },
      ],
    });
  });
});
