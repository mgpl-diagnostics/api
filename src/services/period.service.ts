import type { Id, Repositories } from "@mgpl-diagnostics/db-kit";
import { closeFinancialYear, listLocks, setLockDate } from "@mgpl-diagnostics/finance-kit";
import type { Actor } from "../graphql/context";

/** Lock dates and the year-end close, through finance-kit. */
export class PeriodService {
  constructor(private readonly repos: Repositories) {}

  locks(actor: Actor) {
    return listLocks(this.repos, actor.orgId);
  }

  setLockDate(actor: Actor, input: { branchId?: Id | null; upTo: string | null; reason?: string | null }) {
    return setLockDate(this.repos, { orgId: actor.orgId, branchId: input.branchId ?? null, upTo: input.upTo, reason: input.reason ?? undefined }, actor.userId);
  }

  closeFinancialYear(actor: Actor, fy: string) {
    return closeFinancialYear(this.repos, { orgId: actor.orgId, fy }, actor.userId);
  }
}
