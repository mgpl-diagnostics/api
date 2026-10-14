import type { AccountGroup, Booking, Branch, Customer, Doctor, Invoice, Ledger, Partner, Patient, Repositories, User } from "@mgpl-diagnostics/db-kit";

/**
 * Minimal DataLoader: every load() in the same tick is batched into one getMany(), and results are
 * memoised for the request. Prevents N+1 queries when a list resolves nested fields
 * (50 invoices → 1 query for their patients).
 */
export class BatchLoader<T extends { id: string }> {
  private cache = new Map<string, Promise<T | null>>();
  private queue: { id: string; resolve: (v: T | null) => void; reject: (e: unknown) => void }[] = [];

  constructor(private readonly fetchMany: (ids: readonly string[]) => Promise<T[]>) {}

  load(id: string | null | undefined): Promise<T | null> {
    if (!id) return Promise.resolve(null);
    const hit = this.cache.get(id);
    if (hit) return hit;
    const p = new Promise<T | null>((resolve, reject) => {
      this.queue.push({ id, resolve, reject });
      if (this.queue.length === 1) queueMicrotask(() => void this.flush());
    });
    this.cache.set(id, p);
    return p;
  }

  /** Seeds the cache with an entity you already have (e.g. just created). */
  prime(entity: T): void {
    this.cache.set(entity.id, Promise.resolve(entity));
  }

  clear(id: string): void {
    this.cache.delete(id);
  }

  private async flush(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    try {
      const rows = await this.fetchMany([...new Set(batch.map((b) => b.id))]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const b of batch) b.resolve(byId.get(b.id) ?? null);
    } catch (e) {
      for (const b of batch) {
        this.cache.delete(b.id);
        b.reject(e);
      }
    }
  }
}

/** One set per request (created lazily by the context). */
export function createLoaders(r: Repositories) {
  return {
    patient: new BatchLoader<Patient>((ids) => r.patients.getMany(ids)),
    branch: new BatchLoader<Branch>((ids) => r.branches.getMany(ids)),
    doctor: new BatchLoader<Doctor>((ids) => r.doctors.getMany(ids)),
    booking: new BatchLoader<Booking>((ids) => r.bookings.getMany(ids)),
    invoice: new BatchLoader<Invoice>((ids) => r.invoices.getMany(ids)),
    ledger: new BatchLoader<Ledger>((ids) => r.ledgers.getMany(ids)),
    group: new BatchLoader<AccountGroup>((ids) => r.accountGroups.getMany(ids)),
    customer: new BatchLoader<Customer>((ids) => r.customers.getMany(ids)),
    partner: new BatchLoader<Partner>((ids) => r.partners.getMany(ids)),
    user: new BatchLoader<User>((ids) => r.users.getMany(ids)),
  };
}

export type Loaders = ReturnType<typeof createLoaders>;
