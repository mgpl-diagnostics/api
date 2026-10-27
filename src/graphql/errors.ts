import { AuthError } from "@mgpl-diagnostics/auth-kit";
import { ConflictError, NotFoundError, PeriodLockedError, ValidationError } from "@mgpl-diagnostics/db-kit";
import { CreditLimitError } from "@mgpl-diagnostics/finance-kit";
import { HttpError } from "@mgpl-diagnostics/report-kit";
import { GraphQLError } from "graphql";
import { ForbiddenError } from "../services/util";

/**
 * Every error code a client can see in `errors[].extensions.code`. A public contract: add codes,
 * never rename them (docs/05-errors.md). Anything else is masked as "Unexpected error".
 */
export const ERROR_CODES = [
  "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "BAD_USER_INPUT",
  "PERIOD_LOCKED", "CREDIT_LIMIT_EXCEEDED",
  // auth-kit's own codes, passed through
  "INVALID_CREDENTIALS", "ACCOUNT_DISABLED", "INVITE_PENDING", "ORG_REQUIRED", "RATE_LIMITED", "WEAK_PASSWORD", "INVALID_TOKEN",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export function apiError(code: ErrorCode, message: string, status: number, extra: Record<string, unknown> = {}): GraphQLError {
  // never pass `originalError`: Yoga masks any GraphQLError that wraps a non-GraphQL error as "Unexpected error"
  return new GraphQLError(message, { extensions: { code, http: { status }, ...extra } });
}

export const unauthenticated = () => apiError("UNAUTHENTICATED", "Sign in required", 401);
export const forbidden = (permission: string) => apiError("FORBIDDEN", `Missing permission ${permission}`, 403, { permission });
export const notFound = (what: string) => apiError("NOT_FOUND", `${what} not found`, 404);
export const badInput = (message: string) => apiError("BAD_USER_INPUT", message, 400);

/** Domain errors from the kits → GraphQL errors with codes. Anything unknown is re-thrown (and masked by Yoga). */
export function toGraphQLError(e: unknown): unknown {
  if (e instanceof GraphQLError) return e;
  if (e instanceof AuthError) return apiError(e.code as ErrorCode, e.message, e.statusCode, e.details.retryAfterMs ? { retryAfterMs: e.details.retryAfterMs } : {});
  if (e instanceof ForbiddenError) return apiError("FORBIDDEN", e.message, 403);
  if (e instanceof PeriodLockedError) return apiError("PERIOD_LOCKED", e.message, 409);
  if (e instanceof CreditLimitError) return apiError("CREDIT_LIMIT_EXCEEDED", e.message, 409);
  if (e instanceof NotFoundError) return apiError("NOT_FOUND", e.message, 404);
  if (e instanceof ConflictError) return apiError("CONFLICT", e.message, 409);
  if (e instanceof ValidationError) return apiError("BAD_USER_INPUT", e.message, 400);
  // report-kit / invoice-kit input validation (HttpError 400)
  if (e instanceof HttpError && e.status === 400) return apiError("BAD_USER_INPUT", e.message, 400);
  return e;
}

type ResolverMap = Record<string, Record<string, unknown>>;

/** Wraps every resolver function of a map so domain errors surface with proper codes. */
export function withErrorCodes<R extends ResolverMap>(resolvers: R): R {
  for (const type of Object.values(resolvers)) {
    for (const [field, fn] of Object.entries(type)) {
      if (typeof fn !== "function") continue;
      type[field] = async (...args: unknown[]) => {
        try {
          return await (fn as (...a: unknown[]) => unknown)(...args);
        } catch (e) {
          throw toGraphQLError(e);
        }
      };
    }
  }
  return resolvers;
}
