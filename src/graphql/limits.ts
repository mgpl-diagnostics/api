import { GraphQLError, Kind, type ASTVisitor, type FragmentDefinitionNode, type SelectionSetNode, type ValidationContext } from "graphql";

/** Rejects queries nested deeper than `max` levels (a cheap guard against abusive queries). */
export function depthLimit(max: number) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const d of context.getDocument().definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);
    const depthOf = (set: SelectionSetNode | undefined, depth: number, seen: Set<string>): number => {
      if (!set) return depth;
      let deepest = depth;
      for (const s of set.selections) {
        if (s.kind === Kind.FIELD) deepest = Math.max(deepest, depthOf(s.selectionSet, s.selectionSet ? depth + 1 : depth, seen));
        else if (s.kind === Kind.INLINE_FRAGMENT) deepest = Math.max(deepest, depthOf(s.selectionSet, depth, seen));
        else if (!seen.has(s.name.value)) {
          const f = fragments.get(s.name.value);
          if (f) deepest = Math.max(deepest, depthOf(f.selectionSet, depth, new Set(seen).add(s.name.value)));
        }
      }
      return deepest;
    };
    return {
      OperationDefinition(op) {
        const depth = depthOf(op.selectionSet, 0, new Set());
        if (depth > max) context.reportError(new GraphQLError(`Query is ${depth} levels deep; the limit is ${max}`, { extensions: { code: "BAD_USER_INPUT" } }));
      },
    };
  };
}
