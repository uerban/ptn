import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import rule from "./no-dynamic-errorboundary-context.js";

// Drive RuleTester scenarios from within vitest's `it` callback. Vitest
// silently drops nested `describe`/`it` calls made during a test body
// (RuleTester's default behaviour), so the scenarios would never actually
// assert. Routing them through synchronous wrappers makes RuleTester throw
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
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

describe("no-dynamic-errorboundary-context", () => {
  it("runs the rule tester scenarios", () => {
    ruleTester.run("no-dynamic-errorboundary-context", rule, {
      valid: [
        {
          code: '<ErrorBoundary context="settings"><div /></ErrorBoundary>;',
        },
        {
          code:
            'const ROUTE_HOME = "home"; ' +
            "<ErrorBoundary context={ROUTE_HOME}><div /></ErrorBoundary>;",
        },
        {
          code:
            'const ROUTE_NAME = "home"; ' +
            "<ErrorBoundary context={`route-${ROUTE_NAME}`}><div /></ErrorBoundary>;",
        },
        {
          code: "<ErrorBoundary fallback={null}><div /></ErrorBoundary>;",
        },
        // Local `const` alias of an imported ErrorBoundary still allows
        // a literal context — the rule only fires on dynamic values.
        {
          code:
            'import { ErrorBoundary } from "./eb"; ' +
            "const Boundary = ErrorBoundary; " +
            '<Boundary context="settings"><div /></Boundary>;',
        },
        // Lexical shadow: an inner binding named the same as the imported
        // alias is unrelated to ErrorBoundary, so the rule must not fire.
        {
          code:
            'import { ErrorBoundary as Boundary } from "./eb"; ' +
            "function Wrap(props) { " +
            "const Boundary = OtherComp; " +
            "return <Boundary context={props.userId}><div /></Boundary>; " +
            "}",
        },
        // Namespace-import member access to a non-ErrorBoundary export
        // does not trigger the rule.
        {
          code:
            'import * as UI from "./eb"; ' +
            "<UI.Modal context={userId}><div /></UI.Modal>;",
        },
        // Namespace-import access to ErrorBoundary with a literal context
        // is allowed.
        {
          code:
            'import * as UI from "./eb"; ' +
            '<UI.ErrorBoundary context="home"><div /></UI.ErrorBoundary>;',
        },
        // Lexical shadow of a namespace-import binding: the inner `UI` is a
        // different value, so `<UI.ErrorBoundary>` at the use-site is not
        // the imported boundary and the rule must not fire.
        {
          code:
            'import * as UI from "./eb"; ' +
            "function Wrap(props) { " +
            "const UI = OtherNs; " +
            "return <UI.ErrorBoundary context={props.userId}><div /></UI.ErrorBoundary>; " +
            "}",
        },
        // Same shadowing rule applies when the alias is derived via
        // namespace-member access.
        {
          code:
            'import * as UI from "./eb"; ' +
            "function Wrap(props) { " +
            "const UI = OtherNs; " +
            "const Boundary = UI.ErrorBoundary; " +
            "return <Boundary context={props.userId}><div /></Boundary>; " +
            "}",
        },
      ],
      invalid: [
        {
          code: "<ErrorBoundary context={userId}><div /></ErrorBoundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        {
          code: "<ErrorBoundary context={getContext()}><div /></ErrorBoundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        {
          code: "<ErrorBoundary context={`user-${userId}`}><div /></ErrorBoundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        {
          code: "<ErrorBoundary {...props}><div /></ErrorBoundary>;",
          errors: [{ messageId: "spread" }],
        },
        {
          code: '<ErrorBoundary {...props} context="settings"><div /></ErrorBoundary>;',
          errors: [{ messageId: "spread" }],
        },
        // ALL_CAPS identifier bound to a non-literal initializer leaks user data.
        {
          code:
            "const ROUTE = getUserStop(); " +
            "<ErrorBoundary context={ROUTE}><div /></ErrorBoundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // ALL_CAPS via `let` is not a compile-time constant.
        {
          code:
            'let ROUTE = "home"; ' +
            "<ErrorBoundary context={ROUTE}><div /></ErrorBoundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // ALL_CAPS declared inside a function scope, not module scope.
        {
          code:
            "function Wrap() { " +
            'const ROUTE = "home"; ' +
            "return <ErrorBoundary context={ROUTE}><div /></ErrorBoundary>; " +
            "}",
          errors: [{ messageId: "dynamic" }],
        },
        // ALL_CAPS identifier with no binding in scope (e.g. global).
        {
          code: "<ErrorBoundary context={UNBOUND_NAME}><div /></ErrorBoundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // Template-literal interpolation of a non-literal ALL_CAPS.
        {
          code:
            "const ROUTE = getUserStop(); " +
            "<ErrorBoundary context={`r-${ROUTE}`}><div /></ErrorBoundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // Aliased import of ErrorBoundary still gets checked.
        {
          code:
            'import { ErrorBoundary as Boundary } from "./eb"; ' +
            "<Boundary context={userId}><div /></Boundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // Local `const` re-binding of an imported ErrorBoundary is tracked.
        {
          code:
            'import { ErrorBoundary } from "./eb"; ' +
            "const Boundary = ErrorBoundary; " +
            "<Boundary context={userId}><div /></Boundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // Chained `const` alias (B = A = ErrorBoundary) is tracked.
        {
          code:
            'import { ErrorBoundary } from "./eb"; ' +
            "const A = ErrorBoundary; " +
            "const B = A; " +
            "<B context={userId}><div /></B>;",
          errors: [{ messageId: "dynamic" }],
        },
        // `let` re-binding of an imported ErrorBoundary is also tracked —
        // restricting to `const` only would let dynamic context slip through.
        {
          code:
            'import { ErrorBoundary } from "./eb"; ' +
            "let Boundary = ErrorBoundary; " +
            "<Boundary context={userId}><div /></Boundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // Inner shadow of the import name must not mask alias resolution:
        // `A` was bound to the real `ErrorBoundary` at module scope, so
        // chasing `A`'s initializer must resolve `Outer` in the declarator's
        // scope (module), not in the JSX use-site scope where `Outer` is
        // shadowed.
        {
          code:
            'import { ErrorBoundary as Outer } from "./eb"; ' +
            "const A = Outer; " +
            "function Wrap(props) { " +
            "const Outer = OtherComp; " +
            "return <A context={props.userId}><div /></A>; " +
            "}",
          errors: [{ messageId: "dynamic" }],
        },
        // Namespace-import access to ErrorBoundary is tracked.
        {
          code:
            'import * as UI from "./eb"; ' +
            "<UI.ErrorBoundary context={userId}><div /></UI.ErrorBoundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // Re-binding a namespace-import member is tracked.
        {
          code:
            'import * as UI from "./eb"; ' +
            "const Boundary = UI.ErrorBoundary; " +
            "<Boundary context={userId}><div /></Boundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // Computed namespace-member access with a string-literal property
        // is just an alternate spelling of dot access; the rule must still
        // resolve `Boundary` to the imported ErrorBoundary.
        {
          code:
            'import * as UI from "./eb"; ' +
            'const Boundary = UI["ErrorBoundary"]; ' +
            "<Boundary context={userId}><div /></Boundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // Direct computed access on the namespace import in JSX.
        {
          code:
            'import * as UI from "./eb"; ' +
            'const Boundary = UI["ErrorBoundary"]; ' +
            "<Boundary context={getId()}><div /></Boundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // An unrelated namespace import (e.g. React) must NOT disable the
        // plain `<ErrorBoundary>` fallback. The local `const ErrorBoundary`
        // points to an unresolved identifier, so it's effectively the free
        // ErrorBoundary tag — dynamic context still has to be flagged.
        {
          code:
            'import * as React from "react"; ' +
            "const ErrorBoundary = LocalBoundary; " +
            "<ErrorBoundary context={userId}><div /></ErrorBoundary>;",
          errors: [{ messageId: "dynamic" }],
        },
        // Alias chain that bounces through a shadow back to the import:
        // the inner `const ErrorBoundary = Boundary` and the imported
        // `ErrorBoundary` are two distinct bindings that share a name.
        // Cycle detection must key on resolved binding identity, not on
        // the identifier text, or the alias chain aborts before reaching
        // the import and dynamic context slips through.
        {
          code:
            'import { ErrorBoundary } from "./eb"; ' +
            "const Boundary = ErrorBoundary; " +
            "function Wrap(props) { " +
            "const ErrorBoundary = Boundary; " +
            "return <ErrorBoundary context={props.userId}><div /></ErrorBoundary>; " +
            "}",
          errors: [{ messageId: "dynamic" }],
        },
      ],
    });
  });
});
