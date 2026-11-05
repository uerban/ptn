import { Linter, RuleTester } from "eslint";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import rule from "./no-raw-coarsen-cast.js";

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
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("no-raw-coarsen-cast", () => {
  it("runs the rule tester scenarios", () => {
    ruleTester.run("no-raw-coarsen-cast", rule, {
      valid: [
        {
          code: "const r = {} as CoarsenedRequest;",
          filename: "/abs/src/services/coordPrivacy.ts",
        },
        {
          code: "const c = raw as LatLon;",
          filename: "/abs/src/services/coordPrivacy.ts",
        },
        {
          code: "const r = {} as CoarsenedRequest;",
          filename: "/abs/src/services/coordPrivacy.test.ts",
        },
        {
          code: "const x = foo as SomeOtherType;",
          filename: "/abs/src/services/geocoder/adapter.ts",
        },
        {
          code: "const x = foo as unknown;",
          filename: "/abs/src/components/Map.tsx",
        },
      ],
      invalid: [
        {
          code: "const r = {} as CoarsenedRequest;",
          filename: "/abs/src/services/geocoder/adapter.ts",
          errors: [{ messageId: "rawCast" }],
        },
        {
          code: "const c = raw as LatLon;",
          filename: "/abs/src/components/Map.tsx",
          errors: [{ messageId: "rawCast" }],
        },
        {
          code: "return value as CoarsenedRequest;",
          filename: "/abs/src/utils/helper.ts",
          errors: [{ messageId: "rawCast" }],
        },
        {
          code: "const a = x as LatLon;",
          filename: "/abs/src/services/geocoder/ThirdPartyGeocoderAdapter.ts",
          errors: [{ messageId: "rawCast" }],
        },
      ],
    });
  });
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "__fixtures__");

const fixtureConfig = [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    plugins: {
      "ptn-local": {
        rules: {
          "no-raw-coarsen-cast": rule,
        },
      },
    },
    rules: {
      "ptn-local/no-raw-coarsen-cast": "error",
    },
  },
];

function lintFixture(fixtureName, simulatedFilename) {
  const code = readFileSync(join(FIXTURES_DIR, fixtureName), "utf8");
  const linter = new Linter();
  const messages = linter.verify(code, fixtureConfig, {
    filename: simulatedFilename,
  });
  return messages.filter(
    (m) => m.ruleId === "ptn-local/no-raw-coarsen-cast",
  );
}

describe("no-raw-coarsen-cast fixture harness", () => {
  it("allows casts in coordPrivacy.ts", () => {
    const errors = lintFixture(
      "allowed-coord-privacy.ts",
      "src/services/coordPrivacy.ts",
    );
    expect(errors).toHaveLength(0);
  });

  it("forbids casts in a service file", () => {
    const errors = lintFixture(
      "forbidden-service.ts",
      "src/services/geocoder/SomeService.ts",
    );
    expect(errors).toHaveLength(2);
  });

  it("forbids casts in a component file", () => {
    const errors = lintFixture(
      "forbidden-component.tsx",
      "src/components/SomeComponent.tsx",
    );
    expect(errors).toHaveLength(3);
  });
});
