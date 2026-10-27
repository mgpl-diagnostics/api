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

/** Root fields that render a PDF / HTML document or build a CSV: CPU-heavy, so few per operation. */
const DOCUMENT_FIELD = /^(bookingReportDocument|invoiceDocument|renderReport|renderInvoice|letterhead|export[A-Z]\w*)$/;

/**
 * Rejects operations that select more than `maxFields` fields in all (fragments counted where they are
 * spread, so aliases and repeated fragments add up), more than `maxRootFields` top-level fields, or more
 * than `maxDocuments` document / export fields.
 * Depth alone does not stop amplification: 1,000 aliases of `trialBalance` are only 2 levels deep.
 */
export function costLimit(maxFields: number, maxDocuments: number, maxRootFields = Infinity) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const d of context.getDocument().definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);
    return {
      OperationDefinition(op) {
        let fields = 0;
        let documents = 0;
        const walk = (set: SelectionSetNode | undefined, root: boolean, seen: Set<string>) => {
          if (!set || fields > maxFields) return;
          for (const s of set.selections) {
            if (s.kind === Kind.FIELD) {
              fields++;
              if (root && DOCUMENT_FIELD.test(s.name.value)) documents++;
              walk(s.selectionSet, false, seen);
            } else if (s.kind === Kind.INLINE_FRAGMENT) walk(s.selectionSet, root, seen);
            else if (!seen.has(s.name.value)) walk(fragments.get(s.name.value)?.selectionSet, root, new Set(seen).add(s.name.value));
          }
        };
        walk(op.selectionSet, true, new Set());
        let roots = 0;
        const countRoots = (set: SelectionSetNode | undefined, seen: Set<string>) => {
          for (const s of set?.selections ?? []) {
            if (s.kind === Kind.FIELD) roots++;
            else if (s.kind === Kind.INLINE_FRAGMENT) countRoots(s.selectionSet, seen);
            else if (!seen.has(s.name.value)) countRoots(fragments.get(s.name.value)?.selectionSet, new Set(seen).add(s.name.value));
          }
        };
        countRoots(op.selectionSet, new Set());
        if (roots > maxRootFields) context.reportError(new GraphQLError(`Query has ${roots} top-level fields; the limit is ${maxRootFields}`, { extensions: { code: "BAD_USER_INPUT" } }));
        if (fields > maxFields) context.reportError(new GraphQLError(`Query selects more than ${maxFields} fields; the limit is ${maxFields}`, { extensions: { code: "BAD_USER_INPUT" } }));
        if (documents > maxDocuments) context.reportError(new GraphQLError(`Query renders ${documents} documents; the limit is ${maxDocuments} per request (use startDocumentJob for more)`, { extensions: { code: "BAD_USER_INPUT" } }));
      },
    };
  };
}
