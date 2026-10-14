import type { Id, ItemCategory, Repositories, Taxability } from "@mgpl-diagnostics/db-kit";
import { addTaxRule, DEFAULT_TAX_RULES, financeConfig, gstr1, gstr3b, seedTaxRules, VERIFY_WITH_CA } from "@mgpl-diagnostics/finance-kit";
import type { Actor } from "../graphql/context";

export interface TaxRuleInput {
  code?: string | null;
  category?: ItemCategory | null;
  hsnSac: string;
  taxability: Taxability;
  ratePercent: number;
  /** IST day, "2026-04-01". */
  effectiveFrom: string;
  note?: string | null;
}

/**
 * GST through finance-kit: tax rules (configuration, to be verified with the lab's CA), GSTR-1 and
 * GSTR-3B data. Nothing here is legal advice; `verifyWithCA` travels with every return.
 */
export class GstService {
  constructor(private readonly repos: Repositories) {}

  taxRules(actor: Actor) {
    return this.repos.taxRules.find({ orgId: actor.orgId }, { sort: { field: "effectiveFrom", dir: "desc" } });
  }

  addTaxRule(actor: Actor, input: TaxRuleInput) {
    return addTaxRule(this.repos, actor.orgId, { ...input, code: input.code ?? null, category: input.category ?? null, note: input.note ?? undefined }, actor.userId);
  }

  /** finance-kit's starting rules (DEFAULT_TAX_RULES). Every rate is marked "verify with CA". */
  seedTaxRules(actor: Actor) {
    return seedTaxRules(this.repos, actor.orgId, DEFAULT_TAX_RULES, actor.userId);
  }

  config(actor: Actor) {
    return financeConfig(this.repos, actor.orgId);
  }

  verifyWithCA(): readonly string[] {
    return VERIFY_WITH_CA;
  }

  gstr1(actor: Actor, q: { from: Date; to: Date; gstin?: string | null }) {
    return gstr1(this.repos, { orgId: actor.orgId, from: q.from, to: q.to, gstin: q.gstin ?? undefined });
  }

  gstr3b(actor: Actor, q: { from: Date; to: Date; gstin?: string | null }) {
    return gstr3b(this.repos, { orgId: actor.orgId, from: q.from, to: q.to, gstin: q.gstin ?? undefined });
  }
}
