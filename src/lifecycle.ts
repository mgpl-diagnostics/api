// Process lifecycle for running several API replicas behind a load balancer: readiness while draining,
// and a graceful shutdown on SIGTERM (what Docker, Kubernetes and systemd send before killing a process).
import type { FastifyInstance } from "fastify";

const draining = new WeakSet<FastifyInstance>();

/** True once shutdown has begun: GET /health answers 503 so the load balancer stops routing here. */
export const isDraining = (app: FastifyInstance): boolean => draining.has(app);

export interface ShutdownOptions {
  /** Keep serving this long after the signal, with /health at 503, so the load balancer notices first. */
  drainMs: number;
  /** Exit with code 1 if shutting down takes longer than this in all. */
  timeoutMs: number;
  log?: (msg: string) => void;
}

/**
 * Stops `app` gracefully: mark it draining → wait `drainMs` → `app.close()` (stops accepting connections,
 * answers 503 to new requests on open ones, waits for the requests in flight, then runs onClose hooks, which
 * close the container) → exit 0. A second signal, or `timeoutMs`, exits at once with 1.
 */
export async function shutdown(app: FastifyInstance, o: ShutdownOptions): Promise<void> {
  if (draining.has(app)) return;
  draining.add(app);
  const timer = setTimeout(() => {
    o.log?.(`[api] shutdown took longer than ${o.timeoutMs} ms: exiting`);
    process.exit(1);
  }, o.timeoutMs);
  timer.unref();
  if (o.drainMs > 0) {
    o.log?.(`[api] draining for ${o.drainMs} ms (GET /health → 503)`);
    await new Promise((r) => setTimeout(r, o.drainMs));
  }
  await app.close();
  clearTimeout(timer);
}

/** Wires SIGTERM and SIGINT to `shutdown`, then exits. Used by `main.ts`. */
export function shutdownOnSignals(app: FastifyInstance, o: ShutdownOptions): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (draining.has(app)) {
        o.log?.(`[api] ${signal} again: exiting now`);
        process.exit(1);
      }
      o.log?.(`[api] ${signal}: shutting down`);
      shutdown(app, o).then(
        () => process.exit(0),
        (e) => {
          o.log?.(`[api] shutdown failed: ${(e as Error).message}`);
          process.exit(1);
        },
      );
    });
  }
}
