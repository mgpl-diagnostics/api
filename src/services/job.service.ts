import type { Id, Repositories } from "@mgpl-diagnostics/db-kit";
import type { Actor } from "../graphql/context";
import type { DocumentJob, JobInfo, JobQueue } from "../jobs/types";
import type { RenderOptions } from "./document.service";
import { mustOwn } from "./util";

/** Background work started from the API: documents rendered by the worker, read back by their owner. */
export class JobService {
  constructor(
    private readonly repos: Repositories,
    private readonly queue: () => JobQueue,
  ) {}

  /** Queues a stored invoice for rendering. The caller has checked `invoice:read` on its branch. */
  async invoiceDocument(actor: Actor, invoiceId: Id, options: RenderOptions): Promise<JobInfo> {
    mustOwn(await this.repos.invoices.get(invoiceId), actor.orgId, "Invoice", invoiceId);
    return this.queue().document({ kind: "invoice", actor, invoiceId, options });
  }

  /** Queues a booking's reports for rendering. The caller has checked `report:read` on its branch. */
  async bookingReports(actor: Actor, bookingId: Id, reportIds: Id[] | null, options: RenderOptions): Promise<JobInfo> {
    mustOwn(await this.repos.bookings.get(bookingId), actor.orgId, "Booking", bookingId);
    return this.queue().document({ kind: "booking_reports", actor, bookingId, reportIds, options } satisfies DocumentJob);
  }

  /** A job of this user; null when unknown, expired, or started by someone else. */
  async get(actor: Actor, id: string): Promise<JobInfo | null> {
    const job = await this.queue().get(id);
    return job && job.actor.userId === actor.userId && job.actor.orgId === actor.orgId ? job : null;
  }

  mode() {
    return this.queue().mode;
  }
}
