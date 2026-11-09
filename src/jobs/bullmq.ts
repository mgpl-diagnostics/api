import { randomUUID } from "node:crypto";
import { Job, Queue, QueueEvents, UnrecoverableError, Worker, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import type { RenderedDocument } from "../services/document.service";
import { processDocument, processImport, processPasswordReset, processReextract, type JobDeps } from "./processors";
import { JobFailure, QUEUES, type DocumentJob, type ImportJob, type JobInfo, type JobQueue, type JobState, type PasswordResetJob, type ReextractJob } from "./types";

export interface BullOptions {
  redisUrl: string;
  prefix: string;
  /** How long finished jobs (and their documents) stay readable. */
  keepResultsMs: number;
}

// BullMQ needs maxRetriesPerRequest: null on its connections (blocking commands)
const connect = (url: string) => new Redis(url, { maxRetriesPerRequest: null });

const jobOptions = (o: BullOptions, attempts: number): JobsOptions => ({
  jobId: randomUUID(), // unguessable; ownership is still checked on every read
  attempts,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { age: Math.ceil(o.keepResultsMs / 1000) },
  removeOnFail: { age: Math.max(86_400, Math.ceil(o.keepResultsMs / 1000)) },
});

const STATES: Record<string, JobState> = { waiting: "waiting", "waiting-children": "waiting", prioritized: "waiting", active: "active", completed: "completed", failed: "failed", delayed: "delayed" };

async function toInfo(job: Job<DocumentJob, RenderedDocument>): Promise<JobInfo> {
  const state = STATES[await job.getState()] ?? "waiting";
  return {
    id: job.id!,
    kind: job.data.kind,
    state,
    attempts: job.attemptsMade,
    error: state === "failed" ? (job.failedReason ?? "Job failed") : null,
    document: state === "completed" ? (job.returnvalue ?? null) : null,
    createdAt: new Date(job.timestamp),
    finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    actor: job.data.actor,
  };
}

/** The producer side, used by the API process: adds jobs to Redis. `npm run worker` runs them. */
export function createBullJobQueue(o: BullOptions): JobQueue {
  const connection = connect(o.redisUrl);
  const mail = new Queue<PasswordResetJob>(QUEUES.mail, { connection, prefix: o.prefix });
  const documents = new Queue<DocumentJob, RenderedDocument>(QUEUES.documents, { connection, prefix: o.prefix });
  const imports = new Queue<ImportJob | ReextractJob>(QUEUES.imports, { connection, prefix: o.prefix });
  // completion events for imports the API waits on (opened on first use: it holds its own connection)
  let events: QueueEvents | undefined;
  return {
    mode: "bullmq",
    async passwordReset(job) {
      await mail.add("password-reset", job, jobOptions(o, 5));
    },
    async document(job) {
      return toInfo(await documents.add(job.kind, job, jobOptions(o, 2)));
    },
    async get(id) {
      const job = await Job.fromId<DocumentJob, RenderedDocument>(documents, id);
      return job ? toInfo(job) : null;
    },
    async importReport(job, waitMs) {
      if (!events) {
        events = new QueueEvents(QUEUES.imports, { connection: connect(o.redisUrl), prefix: o.prefix });
        await events.waitUntilReady();
      }
      // the result holds only an id; the job is removed once read
      const added = await imports.add("extract", job, { ...jobOptions(o, 2), removeOnComplete: true });
      try {
        return (await added.waitUntilFinished(events, waitMs)) as { externalReportId: string };
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (/timed out/i.test(msg)) throw new JobFailure("Reading the report is taking longer than expected; it will appear in externalReports when done", false);
        throw new JobFailure(msg.replace(/^Error:\s*/, "") || "Job failed", false);
      }
    },
    async reextract(job) {
      await imports.add("reextract", job, { ...jobOptions(o, 3), removeOnComplete: true });
    },
    async close() {
      await Promise.all([mail.close(), documents.close(), imports.close(), events?.close()]);
      await connection.quit();
    },
  };
}

/** The consumer side (`src/worker.ts`): one BullMQ Worker per queue, sharing the API's services. */
export function startWorkers(deps: JobDeps, o: BullOptions & { concurrency: number }) {
  const connection = connect(o.redisUrl);
  // a JobFailure that retrying cannot fix fails the job at once
  const run = <T>(fn: () => Promise<T>) =>
    fn().catch((e: unknown) => {
      if (e instanceof JobFailure && !e.retry) throw new UnrecoverableError(e.message);
      throw e;
    });
  const workers = [
    new Worker<PasswordResetJob>(QUEUES.mail, (job) => run(() => processPasswordReset(deps, job.data)), { connection, prefix: o.prefix, concurrency: o.concurrency }),
    new Worker<DocumentJob, RenderedDocument>(QUEUES.documents, (job) => run(() => processDocument(deps, job.data)), { connection, prefix: o.prefix, concurrency: o.concurrency }),
    new Worker<ImportJob | ReextractJob>(
      QUEUES.imports,
      (job) => run<unknown>(() => (job.data.kind === "extract" ? processImport(deps, job.data) : processReextract(deps, job.data))),
      { connection, prefix: o.prefix, concurrency: o.concurrency },
    ),
  ];
  for (const w of workers) w.on("failed", (job, err) => console.warn(`[worker] ${w.name} job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`));
  return {
    workers,
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await connection.quit();
    },
  };
}
