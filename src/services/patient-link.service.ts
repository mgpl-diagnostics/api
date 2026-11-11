import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ConflictError, type Booking, type Id, type PatientLink, type Repositories } from "@mgpl-diagnostics/db-kit";
import type { RateLimiter } from "@mgpl-diagnostics/auth-kit";
import type { Actor } from "../graphql/context";
import { mustOwn } from "./util";

export interface PatientLinkConfig {
  /** HMAC secret (32+ characters). Without it, links are off and documents print their old QR. */
  secret: string | null;
  /** The public page, e.g. "https://dashboard.example.com/r/" (the token is appended). */
  baseUrl: string | null;
  /** How long a link works. */
  ttlDays: number;
}

/** What a patient sees from their link: one booking's bill and released reports. Nothing else. */
export interface PatientView {
  link: PatientLink;
  booking: Booking;
  patientName: string;
  labName: string;
  branch: { name: string; phone: string | null; address: string | null };
  invoices: { id: Id; invoiceNo: string; issuedAt: Date; totalPaise: number; paidPaise: number; duePaise: number; status: string }[];
  /** Released reports only (verified ones are not yet given out). */
  reports: { id: Id; testName: string; releasedAt: Date | null }[];
  /** Tests still in the lab, by name. */
  pending: string[];
}

/** Too many patient page calls from one address (RATE_LIMITED). */
export class PatientLinkRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Too many requests. Try again in a few minutes.");
    this.name = "PatientLinkRateLimitError";
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** "Ravi Kumar Sahu" → "Ravi K. S.": enough for the patient to recognise, little for anyone else. */
export function shortName(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  return [first, ...rest.map((w) => `${w[0]!.toUpperCase()}.`)].join(" ");
}

/**
 * Patient links: the QR on a report or a bill opens a read-only page with that booking's bill and released
 * reports. The token (32 random-looking bytes, base64url) is HMAC(secret, nonce); only its SHA-256 and the
 * nonce are stored, so a database copy alone cannot open any link, and the server can print the same link
 * again. Links expire and can be revoked; a revoked booking gets a new link on its next print.
 */
export class PatientLinkService {
  constructor(private readonly repos: Repositories, private readonly config: PatientLinkConfig, private readonly limiter: RateLimiter | null = null) {}

  /** Counts one patient page call from `ip` (every call, good token or not); throws when over the limit. */
  async throttle(ip: string | undefined): Promise<void> {
    if (!this.limiter) return;
    const r = await this.limiter.hit(`patient-link:${ip ?? "unknown"}`);
    if (!r.allowed) throw new PatientLinkRateLimitError(r.retryAfterMs);
  }

  get enabled(): boolean {
    return !!this.config.secret && !!this.config.baseUrl;
  }

  private token(nonce: string): string {
    return createHmac("sha256", this.config.secret!).update(nonce).digest("base64url");
  }

  private url(token: string): string {
    return `${this.config.baseUrl}${token}`;
  }

  private live(l: PatientLink, now = new Date()): boolean {
    return !l.revokedAt && new Date(l.expiresAt).getTime() > now.getTime();
  }

  /** The booking's current link (created on first use), or null when links are off. */
  async linkFor(orgId: Id, booking: Booking, createdBy: Id | null = null): Promise<{ url: string; expiresAt: Date } | null> {
    if (!this.enabled || booking.orgId !== orgId || booking.status === "cancelled") return null;
    const existing = (await this.repos.patientLinks.find({ orgId, bookingId: booking.id } as never, { sort: { field: "createdAt", dir: "desc" }, limit: 5 })).find((l) => this.live(l));
    if (existing) {
      const token = this.token(existing.nonce);
      // a link made with another secret (rotated) no longer opens: make a new one
      if (sha256(token) === existing.tokenHash) return { url: this.url(token), expiresAt: existing.expiresAt };
    }
    const nonce = randomBytes(24).toString("base64url");
    const token = this.token(nonce);
    const expiresAt = new Date(Date.now() + this.config.ttlDays * 86_400_000);
    await this.repos.patientLinks.create({
      orgId, branchId: booking.branchId, bookingId: booking.id, patientId: booking.patientId, tokenHash: sha256(token), nonce, expiresAt, createdBy, viewCount: 0,
    });
    return { url: this.url(token), expiresAt };
  }

  /** Staff: the link for a booking (to send or show), creating it when needed. */
  async forBooking(actor: Actor, booking: Booking) {
    if (!this.enabled) throw new ConflictError("Patient links are off: set PATIENT_LINK_SECRET and PATIENT_LINK_BASE_URL");
    mustOwn(booking, actor.orgId, "Booking", booking.id);
    if (booking.status === "cancelled") throw new ConflictError("The booking is cancelled");
    return (await this.linkFor(actor.orgId, booking, actor.userId))!;
  }

  /** Staff: stops every link of the booking at once (printed QRs stop opening). The next print makes a new one. */
  async revoke(actor: Actor, booking: Booking): Promise<number> {
    mustOwn(booking, actor.orgId, "Booking", booking.id);
    const links = (await this.repos.patientLinks.find({ orgId: actor.orgId, bookingId: booking.id } as never)).filter((l) => !l.revokedAt);
    const now = new Date();
    for (const l of links) await this.repos.patientLinks.update(l.id, { revokedAt: now, revokedBy: actor.userId });
    if (links.length) await this.repos.audit.log({ orgId: actor.orgId, branchId: booking.branchId, userId: actor.userId, action: "patient_link.revoke", entity: "booking", entityId: booking.id, data: { links: links.length } });
    return links.length;
  }

  /** The live link for a token, or null (unknown, expired, revoked and malformed all look the same). */
  async resolve(token: string): Promise<PatientLink | null> {
    if (!this.enabled || !TOKEN.test(token)) return null;
    const hash = sha256(token);
    const link = await this.repos.patientLinks.findOne({ tokenHash: hash } as never);
    if (!link || !this.live(link)) return null;
    // constant-time check that the token is the one derived from this row (a copied hash alone never opens it)
    const want = Buffer.from(this.token(link.nonce));
    const got = Buffer.from(token);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    return link;
  }

  /** The live link and its booking for a token, or null (also when the booking was cancelled). */
  async open(token: string): Promise<{ link: PatientLink; booking: Booking } | null> {
    const link = await this.resolve(token);
    if (!link) return null;
    const booking = await this.repos.bookings.get(link.bookingId);
    if (!booking || booking.orgId !== link.orgId || booking.id !== link.bookingId || booking.status === "cancelled") return null;
    return { link, booking };
  }

  /** What the patient's page shows, or null. Counts the view. */
  async view(token: string): Promise<PatientView | null> {
    const opened = await this.open(token);
    if (!opened) return null;
    const { link, booking } = opened;
    const [patient, branch, org, invoices, reports] = await Promise.all([
      this.repos.patients.get(booking.patientId),
      this.repos.branches.get(booking.branchId),
      this.repos.orgs.get(booking.orgId),
      this.repos.invoices.find({ orgId: booking.orgId, bookingId: booking.id } as never, { sort: { field: "createdAt", dir: "asc" } }),
      this.repos.reports.find({ bookingId: booking.id }),
    ]);
    await this.repos.patientLinks.update(link.id, { viewCount: (link.viewCount ?? 0) + 1, lastViewedAt: new Date() });
    const released = reports.filter((r) => r.status === "released");
    const done = new Set(released.map((r) => r.testCode));
    return {
      link,
      booking,
      patientName: shortName(patient?.name ?? "Patient"),
      labName: org?.name ?? "",
      branch: { name: branch?.name ?? "", phone: branch?.phone ?? null, address: [branch?.address?.line1, branch?.address?.city].filter(Boolean).join(", ") || null },
      invoices: invoices.filter((i) => i.status !== "cancelled" && i.status !== "draft").map((i) => ({
        id: i.id, invoiceNo: i.invoiceNo, issuedAt: i.issuedAt ?? i.createdAt, totalPaise: i.totalPaise, paidPaise: i.paidPaise, duePaise: i.duePaise, status: i.status,
      })),
      reports: released.map((r) => ({ id: r.id, testName: r.testName, releasedAt: r.releasedAt ?? null })),
      pending: booking.tests.filter((t) => !done.has(t.testCode)).map((t) => t.name),
    };
  }
}
