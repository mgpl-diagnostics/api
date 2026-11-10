// Browser sessions in httpOnly cookies (docs/06-auth-and-permissions.md, "Cookies or bearer").
//
// A browser client sends `x-mgpl-auth: cookie` on every request. login then sets the access and refresh
// tokens as httpOnly, Secure, SameSite cookies instead of returning them, and later requests authenticate
// with the access cookie. Scripts on the page never see a token, so an XSS bug cannot copy one.
//
// CSRF: cookies are read only when the request carries that header AND its Origin is allowed (this host,
// or CORS_ORIGINS). A cross-site form or <img> cannot set a custom header, and a cross-site script can only
// send one after a CORS preflight that CORS_ORIGINS answers. SameSite (Strict by default) is the third layer.
//
// Bearer tokens (Authorization header) keep working for scripts, tests, servers and native apps; a request
// with a bearer token ignores the cookies.

/** The request header that asks for cookie sessions. Its value must be "cookie". */
export const AUTH_MODE_HEADER = "x-mgpl-auth";

export interface CookieConfig {
  /** AUTH_COOKIES: false turns cookie sessions off (every client uses bearer tokens). */
  enabled: boolean;
  /** AUTH_COOKIE_SECURE: Secure flag and the __Host- prefix. Only development over plain http turns it off. */
  secure: boolean;
  /** AUTH_COOKIE_SAMESITE: Strict (default) when the dashboard and the api share a site; None for different sites. */
  sameSite: "Strict" | "Lax" | "None";
}

export function cookieNames(cfg: Pick<CookieConfig, "secure">) {
  // __Host-: the browser accepts it only with Secure, Path=/ and no Domain, so no subdomain can set or shadow it
  const p = cfg.secure ? "__Host-" : "";
  return { access: `${p}mgpl_access`, refresh: `${p}mgpl_refresh` };
}

export function parseCookies(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // the first one wins (the most specific path); our tokens are base64url, no decoding needed
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

export function serializeCookie(name: string, value: string, o: { maxAgeMs: number; secure: boolean; sameSite: CookieConfig["sameSite"] }): string {
  if (!/^[A-Za-z0-9._~+/=-]*$/.test(value)) throw new Error("Cookie value has characters that need encoding");
  const maxAge = Math.max(0, Math.floor(o.maxAgeMs / 1000));
  const parts = [`${name}=${value}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly", `SameSite=${o.sameSite}`];
  if (maxAge === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (o.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Whether a cookie request comes from an allowed page: no Origin (not a browser, or a same-origin GET),
 * an Origin on this host, or one listed in CORS_ORIGINS ("*" only in development).
 */
export function originAllowed(headers: Headers, corsOrigins: readonly string[]): boolean {
  const origin = headers.get("origin");
  if (!origin || origin === "null") return origin === null && headers.get("sec-fetch-site") !== "cross-site";
  if (corsOrigins.includes("*") || corsOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === (headers.get("host") ?? "");
  } catch {
    return false;
  }
}

export interface TokenPairLike {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/** The auth cookies of one request: what came in, and how to set or clear them on the response. */
export interface AuthCookies {
  /** The client asked for cookie sessions (header) from an allowed origin, and cookies are enabled. */
  readonly requested: boolean;
  /** The access token from the cookie (only when `requested`). */
  readonly access: string | null;
  /** The refresh token from the cookie (only when `requested`). */
  readonly refresh: string | null;
  set(pair: TokenPairLike): void;
  clear(): void;
}

export function authCookies(cfg: CookieConfig, corsOrigins: readonly string[], headers: Headers, setCookie: (value: string) => void): AuthCookies {
  const names = cookieNames(cfg);
  const requested = cfg.enabled && headers.get(AUTH_MODE_HEADER)?.trim().toLowerCase() === "cookie" && originAllowed(headers, corsOrigins);
  const jar = requested ? parseCookies(headers.get("cookie")) : new Map<string, string>();
  const opts = { secure: cfg.secure, sameSite: cfg.sameSite };
  return {
    requested,
    access: jar.get(names.access) || null,
    refresh: jar.get(names.refresh) || null,
    set(pair) {
      const now = Date.now();
      setCookie(serializeCookie(names.access, pair.accessToken, { ...opts, maxAgeMs: pair.accessExpiresAt.getTime() - now }));
      setCookie(serializeCookie(names.refresh, pair.refreshToken, { ...opts, maxAgeMs: pair.refreshExpiresAt.getTime() - now }));
    },
    clear() {
      setCookie(serializeCookie(names.access, "", { ...opts, maxAgeMs: 0 }));
      setCookie(serializeCookie(names.refresh, "", { ...opts, maxAgeMs: 0 }));
    },
  };
}
