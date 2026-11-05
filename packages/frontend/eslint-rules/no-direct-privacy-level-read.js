const STORE_IDENTIFIERS = new Set([
  "privacyStore",
  "privacyState",
  "usePrivacyStore",
]);

function isStoreIdentifier(node) {
  return (
    node != null &&
    node.type === "Identifier" &&
    STORE_IDENTIFIERS.has(node.name)
  );
}

function isStoreGetStateCall(node) {
  if (!node || node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return false;
  const prop = callee.property;
  if (!prop || prop.type !== "Identifier" || prop.name !== "getState") return false;
  return isStoreIdentifier(callee.object);
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading the raw privacy level; consumers must use usePolicy() / getPolicy() so per-axis overrides are respected.",
    },
    schema: [],
    messages: {
      direct:
        "Do not read the privacy level directly. Import usePolicy() or getPolicy() from the privacy store and read the axis you need off the effective policy.",
    },
  },
  create(context) {
    const filename =
      (typeof context.filename === "string" && context.filename) ||
      (typeof context.getFilename === "function" && context.getFilename()) ||
      "";
    if (/privacyStore(?:\.test)?\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filename)) {
      return {};
    }

    return {
      MemberExpression(node) {
        if (node.computed) return;
        const prop = node.property;
        if (!prop || prop.type !== "Identifier") return;

        if (prop.name === "privacyLevel") {
          context.report({ node, messageId: "direct" });
          return;
        }

        if (prop.name === "level") {
          if (
            isStoreIdentifier(node.object) ||
            isStoreGetStateCall(node.object)
          ) {
            context.report({ node, messageId: "direct" });
          }
        }
      },
    };
  },
};

export default rule;
