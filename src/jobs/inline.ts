import { randomUUID } from "node:crypto";
import { processDocument, processPasswordReset, type JobDeps } from "./processors";
import { JobFailure, type DocumentJob, type JobInfo, type JobQueue, type PasswordResetJob } from "./types";

/**
 * Jobs in this process, at once (no Redis): development, tests and a single server. Same results as
 * BullMQ, but the request waits for the work. Finished document jobs are kept for `keepResultsMs`.
 */
export function createInlineJobQueue(deps: () => JobDeps, o: { keepResultsMs: number }): JobQueue {
  const jobs = new Map<string, JobInfo>();
  const prune = () => {
    const cutoff = Date.now() - o.keepResultsMs;
    for (const [id, j] of jobs) if ((j.finishedAt?.getTime() ?? Infinity) < cutoff) jobs.delete(id);
  };
  return {
    mode: "inline",
    async passwordReset(job: PasswordResetJob) {
      await processPasswordReset(deps(), job);
    },
    async document(job: DocumentJob) {
      prune();
      const info: JobInfo = { id: randomUUID(), kind: job.kind, state: "active", attempts: 1, error: null, document: null, createdAt: new Date(), finishedAt: null, actor: job.actor };
      jobs.set(info.id, info);
      try {
        info.document = await processDocument(deps(), job);
        info.state = "completed";
      } catch (e) {
        info.state = "failed";
        info.error = e instanceof JobFailure ? e.message : "Job failed";
      }
      info.finishedAt = new Date();
      return info;
    },
    async get(id: string) {
      prune();
      return jobs.get(id) ?? null;
    },
    async close() {
      jobs.clear();
    },
  };
}
