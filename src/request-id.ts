import { randomFillSync } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** The header that carries the request id, in both directions. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Ids we accept from a trusted proxy: nginx's `$request_id` (32 hex), Envoy's UUID, AWS/GCP trace ids.
 * Printable, no spaces, no control characters (the id goes into every log line of the request).
 */
const INCOMING = /^[A-Za-z0-9._:\-]{8,128}$/;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const bytes = new Uint8Array(16);

/**
 * A UUIDv7 (RFC 9562): 48-bit Unix time in milliseconds, then 74 random bits. Unique across replicas and
 * restarts, sorts by time, and does not reveal how many requests a replica has served (Fastify's default
 * was a per-process counter, "req-1", "req-2", …).
 */
export function uuidv7(now = Date.now()): string {
  randomFillSync(bytes);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  let s = "";
  for (let i = 0; i < 16; i++) s += (i === 4 || i === 6 || i === 8 || i === 10 ? "-" : "") + HEX[bytes[i]!];
  return s;
}

/**
 * Fastify's `genReqId`. With a trusted proxy in front (TRUST_PROXY ≥ 1) its X-Request-ID is kept when it
 * looks like an id, so the proxy's logs and ours share one id; otherwise (no proxy, missing or malformed
 * header) a new UUIDv7. Without a trusted proxy the header is client input and is ignored.
 */
export function requestIdGenerator(trustedHops: number): (req: IncomingMessage) => string {
  return (req) => {
    const incoming = trustedHops > 0 ? req.headers[REQUEST_ID_HEADER] : undefined;
    return typeof incoming === "string" && INCOMING.test(incoming) ? incoming : uuidv7();
  };
}
