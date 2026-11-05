const BANNED_CAST_TYPES = new Set(["CoarsenedRequest", "LatLon"]);

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `as CoarsenedRequest` / `as LatLon` casts outside coordPrivacy.ts; use coarsen() instead.",
    },
    schema: [],
    messages: {
      rawCast:
        "Do not cast to {{typeName}} directly. Use coarsen() from coordPrivacy.ts to obtain a CoarsenedRequest.",
    },
  },
  create(context) {
    const filename =
      (typeof context.filename === "string" && context.filename) ||
      (typeof context.getFilename === "function" && context.getFilename()) ||
      "";

    if (/coordPrivacy(?:\.test)?\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filename)) {
      return {};
    }

    return {
      TSAsExpression(node) {
        const typeAnnotation = node.typeAnnotation;
        if (
          typeAnnotation &&
          typeAnnotation.type === "TSTypeReference" &&
          typeAnnotation.typeName &&
          typeAnnotation.typeName.type === "Identifier" &&
          BANNED_CAST_TYPES.has(typeAnnotation.typeName.name)
        ) {
          context.report({
            node,
            messageId: "rawCast",
            data: { typeName: typeAnnotation.typeName.name },
          });
        }
      },
    };
  },
};

export default rule;
