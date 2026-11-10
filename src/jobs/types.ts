import type { Id } from "@mgpl-diagnostics/db-kit";
import type { Actor } from "../graphql/context";
import type { RenderedDocument, RenderOptions } from "../services/document.service";

/** Queue names (Redis keys are `<QUEUE_PREFIX>:<queue>:…`). */
export const QUEUES = { mail: "mail", documents: "documents", imports: "imports" } as const;

/** mail queue: the worker creates the reset token itself, so no raw token ever sits in Redis. */
export interface PasswordResetJob {
  email: string;
  orgCode?: string | null;
  ip?: string;
}

export type DocumentJobKind = "invoice" | "booking_reports";

/** documents queue. Permissions were checked when the job was started; the worker re-reads the user. */
export interface DocumentJob {
  kind: DocumentJobKind;
  actor: Actor;
  invoiceId?: Id | null;
  bookingId?: Id | null;
  reportIds?: Id[] | null;
  options: RenderOptions;
}

/**
 * imports queue · extract: reads a stored partner PDF (report-reader) and creates its external report.
 * Carries the stored file's id and the actor, never the file or a token.
 */
export interface ImportJob {
  kind: "extract";
  actor: Actor;
  fileId: Id;
  branchId: Id;
  bookingId?: Id | null;
  fileName?: string | null;
}

/** imports queue · reextract: after a partner signature is named, re-reads that organisation's unapplied imports that carry it. */
export interface ReextractJob {
  kind: "reextract";
  actor: Actor;
  /** the signature's pixel hash */
  sha: string;
}

export type JobState = "waiting" | "active" | "completed" | "failed" | "delayed";

/** A document job as the API shows it. Only the user who started it can read it. */
export interface JobInfo {
  id: string;
  kind: DocumentJobKind;
  state: JobState;
  attempts: number;
  error: string | null;
  document: RenderedDocument | null;
  createdAt: Date;
  finishedAt: Date | null;
  actor: Actor;
}

/**
 * Where services put background work. Two implementations with the same behaviour:
 * BullMQ on Redis (`bullmq.ts`, run `npm run worker`) and in-process (`inline.ts`, no Redis: dev, tests, one server).
 */
export interface JobQueue {
  readonly mode: "bullmq" | "inline";
  passwordReset(job: PasswordResetJob): Promise<void>;
  document(job: DocumentJob): Promise<JobInfo>;
  get(id: string): Promise<JobInfo | null>;
  /** Extracts a large partner PDF in the worker and waits for it (up to IMPORT_WAIT_MS); resolves with the external report's id. */
  importReport(job: ImportJob, waitMs: number): Promise<{ externalReportId: Id }>;
  /** Re-extraction after naming a signature, in the background (inline: at once). */
  reextract(job: ReextractJob): Promise<void>;
  close(): Promise<void>;
}

/** A job failure whose message is safe to show to the client. `retry: false` = retrying cannot help. */
export class JobFailure extends Error {
  constructor(message: string, readonly retry: boolean) {
    super(message);
    this.name = "JobFailure";
  }
}
