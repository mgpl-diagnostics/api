import { AuthError, type Auth } from "@mgpl-diagnostics/auth-kit";
import { ConflictError, NotFoundError, ValidationError, type Repositories } from "@mgpl-diagnostics/db-kit";
import type { Services } from "../services";
import type { RenderedDocument } from "../services/document.service";
import { JobFailure, type DocumentJob, type PasswordResetJob } from "./types";

/** What a job needs: the same services the API uses. */
export interface JobDeps {
  repos: Repositories;
  auth: Auth;
  services: Services;
}

/** mail · password-reset: creates the single-use token (auth-kit) and sends the link (the Mailer). */
export async function processPasswordReset(deps: JobDeps, job: PasswordResetJob): Promise<{ sent: boolean }> {
  try {
    return { sent: await deps.services.auth.sendPasswordReset(job) };
  } catch (e) {
    // too many requests for this email or IP: drop quietly, retrying would only hit the limit again
    if (e instanceof AuthError && e.code === "RATE_LIMITED") return { sent: false };
    throw e;
  }
}

/** documents · invoice | booking_reports: renders a stored document with invoice-kit / report-kit. */
export async function processDocument(deps: JobDeps, job: DocumentJob): Promise<RenderedDocument> {
  const { actor } = job;
  const user = await deps.repos.users.get(actor.userId);
  if (!user || user.status !== "active" || user.orgId !== actor.orgId) throw new JobFailure("The user who started this job is no longer active", false);
  try {
    if (job.kind === "invoice") {
      const invoice = await deps.services.billing.get(actor, job.invoiceId!);
      return await deps.services.documents.renderStoredInvoice(actor, invoice, job.options);
    }
    return await deps.services.documents.renderBookingReports(actor, job.bookingId!, job.reportIds ?? null, job.options);
  } catch (e) {
    // domain errors will not change on a retry, and their messages are safe to show
    if (e instanceof NotFoundError || e instanceof ConflictError || e instanceof ValidationError) throw new JobFailure(e.message, false);
    console.error("[jobs] document job failed", e);
    throw new JobFailure("Rendering failed", true);
  }
}
