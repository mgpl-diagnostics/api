import { istDay } from "@mgpl-diagnostics/finance-kit";
import { GraphQLScalarType, Kind } from "graphql";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const toDate = (v: unknown): Date => {
  const d = v instanceof Date ? v : new Date(v as string);
  if (Number.isNaN(d.getTime())) throw new TypeError("Invalid DateTime");
  return d;
};

/** ISO-8601 instant, e.g. "2026-10-14T09:30:00.000Z". */
export const DateTime = new GraphQLScalarType({
  name: "DateTime",
  description: "ISO-8601 date-time (UTC), e.g. 2026-10-14T09:30:00.000Z",
  serialize: (v) => toDate(v).toISOString(),
  parseValue: (v) => toDate(v),
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? toDate(ast.value) : null),
});

const toDay = (v: unknown): string => {
  if (typeof v !== "string" || !DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new TypeError(`Invalid Day "${String(v)}", expected YYYY-MM-DD`);
  return v;
};

/** A calendar day in India (IST), e.g. "2026-10-14". */
export const Day = new GraphQLScalarType({
  name: "Day",
  description: "Calendar day in IST, YYYY-MM-DD",
  serialize: (v) => (v instanceof Date ? istDay(v) : toDay(v)),
  parseValue: toDay,
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? toDay(ast.value) : null),
});

/** Free-form JSON (report-kit report requests and other open shapes). */
export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Any JSON value",
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: function literal(ast): unknown {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.INT:
      case Kind.FLOAT:
        return Number(ast.value);
      case Kind.OBJECT:
        return Object.fromEntries(ast.fields.map((f) => [f.name.value, literal(f.value)]));
      case Kind.LIST:
        return ast.values.map((v) => literal(v));
      default:
        return null;
    }
  },
});
