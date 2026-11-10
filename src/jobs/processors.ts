import { AuthError, type Auth } from "@mgpl-diagnostics/auth-kit";
import { ConflictError, NotFoundError, ValidationError, type Repositories } from "@mgpl-diagnostics/db-kit";
import type { Services } from "../services";
import type { RenderedDocument } from "../services/document.service";
import { JobFailure, type DocumentJob, type ImportJob, type PasswordResetJob, type ReextractJob } from "./types";
import { UnsupportedReportError } from "@mgpl-diagnostics/report-reader";

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

async function activeActor(deps: JobDeps, actor: { userId: string; orgId: string }) {
  const user = await deps.repos.users.get(actor.userId);
  if (!user || user.status !== "active" || user.orgId !== actor.orgId) throw new JobFailure("The user who started this job is no longer active", false);
}

/** Marks a worker failure that the API turns back into UNSUPPORTED_REPORT. */
export const UNSUPPORTED_PREFIX = "UNSUPPORTED_REPORT: ";

/** imports · extract: a large partner PDF, read off the API's request path. Never logs the file or its contents. */
export async function processImport(deps: JobDeps, job: ImportJob): Promise<{ externalReportId: string }> {
  await activeActor(deps, job.actor);
  try {
    const ext = await deps.services.imports.extractStored(job.actor, job);
    return { externalReportId: ext.id };
  } catch (e) {
    if (e instanceof UnsupportedReportError) throw new JobFailure(`${UNSUPPORTED_PREFIX}${e.message}`, false);
    if (e instanceof NotFoundError || e instanceof ConflictError || e instanceof ValidationError) throw new JobFailure(e.message, false);
    console.error("[jobs] import job failed", (e as Error)?.name ?? "Error");
    throw new JobFailure("Reading the report failed", true);
  }
}

/** imports · reextract: names a newly registered signature in the organisation's unapplied imports. */
export async function processReextract(deps: JobDeps, job: ReextractJob): Promise<{ updated: number }> {
  await activeActor(deps, job.actor);
  return { updated: await deps.services.imports.reextractSignature(job.actor, job.sha) };
}
