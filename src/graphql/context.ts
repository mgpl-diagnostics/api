import type { AuthContext, Viewer } from "@mgpl-diagnostics/auth-kit";
import type { Repositories } from "@mgpl-diagnostics/db-kit";
import type { Container } from "../container";
import type { Services } from "../services";
import { authCookies, type AuthCookies } from "./cookies";
import { createLoaders, type Loaders } from "./loaders";

/** Who is acting: always taken from the session, never from client input. */
export interface Actor {
  userId: string;
  orgId: string;
}

/** Everything a controller (resolver) gets for one request. */
export interface RequestContext extends AuthContext {
  services: Services;
  /** Cached repositories (db-kit `db.repos`); workflows open their own transactions. */
  repos: Repositories;
  viewer: Viewer | null;
  /** The access token of this request, from the bearer header or the access cookie (needed by logout and password change). */
  token: string | null;
  /** Where `token` came from: tokens go back the same way (cookies stay cookies). */
  tokenSource: "bearer" | "cookie" | null;
  /** The auth cookies of this request (src/graphql/cookies.ts). */
  cookies: AuthCookies;
  ip?: string;
  userAgent?: string;
  /** TLS client fingerprint (JA4 / JA3) from the trusted TLS proxy (TLS_FINGERPRINT_HEADER); passed to auth-kit, which stores a hash. */
  tlsFingerprint?: string;
  /** Per-request batch loaders, created on first use. */
  readonly loaders: Loaders;
}

export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return m ? m[1]!.trim() : null;
}

/**
 * Builds the request context through auth-kit, from the Authorization header or, for browser clients
 * that send `x-mgpl-auth: cookie` from an allowed origin, from the access cookie. A bearer token wins.
 * `setCookie` adds a Set-Cookie header to the response.
 */
export async function createContext(container: Container, req: { headers: Headers; ip?: string; tlsFingerprint?: string; setCookie?: (value: string) => void }): Promise<RequestContext> {
  const { config } = container;
  const cookies = authCookies(config.authCookies, config.corsOrigins, req.headers, req.setCookie ?? (() => {}));
  const bearer = bearerToken(req.headers.get("authorization"));
  const token = bearer ?? cookies.access;
  const auth = await container.auth.context(token);
  let loaders: Loaders | undefined;
  const repos = container.db.repos;
  return {
    ...auth,
    services: container.services,
    repos,
    token,
    tokenSource: bearer ? "bearer" : token ? "cookie" : null,
    cookies,
    ip: req.ip,
    userAgent: req.headers.get("user-agent") ?? undefined,
    tlsFingerprint: req.tlsFingerprint,
    get loaders() {
      return (loaders ??= createLoaders(repos));
    },
  };
}
