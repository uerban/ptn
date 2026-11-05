const CONSTANT_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function isLiteralStringInitializer(init) {
  if (!init) return false;
  if (init.type === "Literal" && typeof init.value === "string") return true;
  if (init.type === "TemplateLiteral" && init.expressions.length === 0) {
    return true;
  }
  return false;
}

function resolvesToLiteralStringConst(identifierNode, sourceCode) {
  let scope = sourceCode.getScope(identifierNode);
  while (scope) {
    const variable = scope.variables.find((v) => v.name === identifierNode.name);
    if (variable) {
      const ownerScope = variable.scope;
      if (ownerScope.type !== "module" && ownerScope.type !== "global") {
        return false;
      }
      const def = variable.defs[0];
      if (!def || def.type !== "Variable") return false;
      const declarator = def.node;
      const declaration = def.parent;
      if (
        !declarator ||
        declarator.type !== "VariableDeclarator" ||
        !declaration ||
        declaration.type !== "VariableDeclaration" ||
        declaration.kind !== "const"
      ) {
        return false;
      }
      return isLiteralStringInitializer(declarator.init);
    }
    scope = scope.upper;
  }
  return false;
}

function isAllowedIdentifier(node, sourceCode) {
  return (
    node.type === "Identifier" &&
    CONSTANT_NAME_RE.test(node.name) &&
    resolvesToLiteralStringConst(node, sourceCode)
  );
}

function isAllowedExpression(node, sourceCode) {
  if (!node) return false;
  if (node.type === "Literal" && typeof node.value === "string") return true;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return true;
  }
  if (node.type === "Identifier") return isAllowedIdentifier(node, sourceCode);
  if (node.type === "TemplateLiteral") {
    return node.expressions.every((expr) =>
      isAllowedIdentifier(expr, sourceCode),
    );
  }
  return false;
}

function resolvesToNamespaceImport(name, scope, namespaceLocalNames) {
  if (!namespaceLocalNames.has(name)) return false;
  let current = scope;
  while (current) {
    const variable = current.variables.find((v) => v.name === name);
    if (variable) {
      const def = variable.defs[0];
      return Boolean(
        def &&
          def.type === "ImportBinding" &&
          def.node &&
          def.node.type === "ImportNamespaceSpecifier",
      );
    }
    current = current.upper;
  }
  return false;
}

function isNamespaceMemberOfErrorBoundary(init, scope, namespaceLocalNames) {
  if (
    !init ||
    init.type !== "MemberExpression" ||
    !init.object ||
    init.object.type !== "Identifier" ||
    !init.property
  ) {
    return false;
  }
  if (!resolvesToNamespaceImport(init.object.name, scope, namespaceLocalNames)) {
    return false;
  }
  if (init.computed) {
    return (
      init.property.type === "Literal" &&
      init.property.value === "ErrorBoundary"
    );
  }
  return (
    init.property.type === "Identifier" &&
    init.property.name === "ErrorBoundary"
  );
}

function resolvesToImportedErrorBoundary(
  name,
  scope,
  importLocalNames,
  namespaceLocalNames,
  seen = new Set(),
) {
  let current = scope;
  while (current) {
    const variable = current.variables.find((v) => v.name === name);
    if (variable) {
      // Key cycle detection on the resolved binding identity, not on the
      // identifier text. Distinct lexical bindings can share a name
      // (e.g. an inner `const ErrorBoundary = Boundary` shadowing a
      // module-scope `import { ErrorBoundary }`), and a name-based check
      // would conflate them and abort the alias chain before it reaches
      // the import — letting dynamic context slip through.
      if (seen.has(variable)) return false;
      seen.add(variable);
      const def = variable.defs[0];
      if (!def) return false;
      if (def.type === "ImportBinding") {
        return importLocalNames.has(name);
      }
      if (def.type !== "Variable") return false;
      const declarator = def.node;
      if (!declarator || declarator.type !== "VariableDeclarator") return false;
      const init = declarator.init;
      if (!init) return false;
      const declScope = variable.scope;
      if (init.type === "Identifier") {
        return resolvesToImportedErrorBoundary(
          init.name,
          declScope,
          importLocalNames,
          namespaceLocalNames,
          seen,
        );
      }
      if (
        isNamespaceMemberOfErrorBoundary(init, declScope, namespaceLocalNames)
      ) {
        return true;
      }
      return false;
    }
    current = current.upper;
  }
  return false;
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow dynamic values for ErrorBoundary `context`; only string literals, or ALL_CAPS identifiers bound to a module-scope `const` string literal, are allowed so error telemetry cannot leak user data. The JSX tag is resolved through aliased imports, namespace-import member access (`<UI.ErrorBoundary>`), and identifier re-bindings (chains, both `const` and `let`, including `const B = UI.ErrorBoundary`) so the rule fires on the actual ErrorBoundary even when renamed; lexical shadowing is respected at the alias declarator's scope, not the use-site.",
    },
    schema: [],
    messages: {
      dynamic:
        "ErrorBoundary `context` must be a string literal or an ALL_CAPS identifier bound to a module-scope `const` string literal (optionally inside a template literal). Dynamic values can leak user data into error telemetry.",
      spread:
        "ErrorBoundary does not accept spread attributes — `context` must be a statically-checked literal so error telemetry cannot leak user data.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode();
    const localNames = new Set();
    const namespaceLocalNames = new Set();
    let sawErrorBoundaryNamedImport = false;

    function tagMatchesErrorBoundary(nameNode, scope) {
      if (!nameNode) return false;
      if (nameNode.type === "JSXIdentifier") {
        const tagName = nameNode.name;
        if (
          resolvesToImportedErrorBoundary(
            tagName,
            scope,
            localNames,
            namespaceLocalNames,
          )
        ) {
          return true;
        }
        // The named-import alias chain failed to find a real ErrorBoundary.
        // Only fall back to the bare-name heuristic when no named
        // ErrorBoundary import exists in this file — otherwise the import
        // is the canonical binding and an unrelated local shadowing it
        // would already have been resolved above. Namespace-only imports
        // (e.g. `import * as React from "react"`) must NOT suppress the
        // fallback: they tell us nothing about whether `ErrorBoundary`
        // appears as a free identifier in this file.
        if (!sawErrorBoundaryNamedImport) return tagName === "ErrorBoundary";
        return false;
      }
      if (
        nameNode.type === "JSXMemberExpression" &&
        nameNode.object &&
        nameNode.object.type === "JSXIdentifier" &&
        nameNode.property &&
        nameNode.property.type === "JSXIdentifier" &&
        nameNode.property.name === "ErrorBoundary" &&
        resolvesToNamespaceImport(
          nameNode.object.name,
          scope,
          namespaceLocalNames,
        )
      ) {
        return true;
      }
      return false;
    }

    return {
      ImportDeclaration(node) {
        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported &&
            spec.imported.type === "Identifier" &&
            spec.imported.name === "ErrorBoundary"
          ) {
            sawErrorBoundaryNamedImport = true;
            localNames.add(spec.local.name);
          } else if (spec.type === "ImportNamespaceSpecifier") {
            // Track the namespace local name so `<X.ErrorBoundary>` and
            // `const B = X.ErrorBoundary` chains can still be resolved.
            // Do NOT mark `sawErrorBoundaryNamedImport`: a namespace import
            // alone is not evidence that this file binds `ErrorBoundary`.
            namespaceLocalNames.add(spec.local.name);
          }
        }
      },
      JSXOpeningElement(node) {
        const matches = tagMatchesErrorBoundary(
          node.name,
          sourceCode.getScope(node),
        );
        if (!matches) return;

        const spread = node.attributes.find(
          (a) => a.type === "JSXSpreadAttribute",
        );
        if (spread) {
          context.report({ node: spread, messageId: "spread" });
          return;
        }
        const attr = node.attributes.find(
          (a) =>
            a.type === "JSXAttribute" &&
            a.name &&
            a.name.type === "JSXIdentifier" &&
            a.name.name === "context",
        );
        if (!attr) return;
        const value = attr.value;
        if (value == null) return;
        if (value.type === "Literal" && typeof value.value === "string") return;
        if (
          value.type === "JSXExpressionContainer" &&
          isAllowedExpression(value.expression, sourceCode)
        ) {
          return;
        }
        context.report({ node: attr, messageId: "dynamic" });
      },
    };
  },
};

export default rule;
