import type { AuthContext, Viewer } from "@mgpl-diagnostics/auth-kit";
import type { Repositories } from "@mgpl-diagnostics/db-kit";
import type { Container } from "../container";
import type { Services } from "../services";
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
  /** The bearer token of this request (needed by logout and password change). */
  token: string | null;
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

/** Builds the request context from the Authorization header, through auth-kit. */
export async function createContext(container: Container, req: { headers: Headers; ip?: string; tlsFingerprint?: string }): Promise<RequestContext> {
  const token = bearerToken(req.headers.get("authorization"));
  const auth = await container.auth.context(token);
  let loaders: Loaders | undefined;
  const repos = container.db.repos;
  return {
    ...auth,
    services: container.services,
    repos,
    token,
    ip: req.ip,
    userAgent: req.headers.get("user-agent") ?? undefined,
    tlsFingerprint: req.tlsFingerprint,
    get loaders() {
      return (loaders ??= createLoaders(repos));
    },
  };
}
