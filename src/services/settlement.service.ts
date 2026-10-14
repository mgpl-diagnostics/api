import type { Address, AgreementKind, Id, ItemCategory, PartnerKind, PaymentMode, Repositories, SettlementDeduction, SettlementStatus } from "@mgpl-diagnostics/db-kit";
import {
  accrueSettlement, addAgreement, cancelSettlement, computeSettlement, createPartner, createSettlement, paySettlement, updatePartner,
} from "@mgpl-diagnostics/finance-kit";
import type { Actor } from "../graphql/context";
import { clean, mustOwn } from "./util";

export interface PartnerInput {
  code: string;
  name: string;
  kind: PartnerKind;
  branchId: Id;
  legalName?: string | null;
  pan?: string | null;
  gstin?: string | null;
  stateCode?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: Address | null;
  /** Overrides the default TDS (e.g. a lower-deduction certificate). Verify with CA. */
  tds?: { section: string; rateBp: number } | null;
}

export interface AgreementInput {
  partnerId: Id;
  kind: AgreementKind;
  shareBp?: number | null;
  rates?: { code: string; sharePaise: number }[] | null;
  defaultSharePaise?: number | null;
  categories?: ItemCategory[] | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
}

/**
 * Collection-centre and franchise settlements with TDS, through finance-kit. No doctor referral
 * commissions: settlements are for collection centres and franchises only.
 */
export class SettlementService {
  constructor(private readonly repos: Repositories) {}

  partners(actor: Actor, q: { branchIds: "all" | Id[] }) {
    return this.repos.partners.find({ orgId: actor.orgId }, { sort: { field: "code" } }).then((all) => (q.branchIds === "all" ? all : all.filter((p) => (q.branchIds as Id[]).includes(p.branchId))));
  }

  async partner(actor: Actor, id: Id) {
    return mustOwn(await this.repos.partners.get(id), actor.orgId, "Partner", id);
  }

  createPartner(actor: Actor, input: PartnerInput) {
    return createPartner(this.repos, { ...(clean(input) as PartnerInput), tds: input.tds ?? undefined, orgId: actor.orgId } as never, actor.userId);
  }

  updatePartner(actor: Actor, id: Id, patch: Partial<Omit<PartnerInput, "code" | "branchId">> & { active?: boolean | null }) {
    const p = clean(patch) as Record<string, unknown>;
    if (patch.tds === null) p.tds = null; // back to the default TDS
    return updatePartner(this.repos, { ...p, orgId: actor.orgId, partnerId: id } as never, actor.userId);
  }

  agreements(partnerId: Id) {
    return this.repos.partnerAgreements.find({ partnerId }, { sort: { field: "effectiveFrom", dir: "desc" } });
  }

  addAgreement(actor: Actor, input: AgreementInput) {
    return addAgreement(this.repos, { ...(clean(input) as AgreementInput), orgId: actor.orgId } as never, actor.userId);
  }

  compute(actor: Actor, q: { partnerId: Id; period: string; deductions?: SettlementDeduction[] | null }) {
    return computeSettlement(this.repos, { orgId: actor.orgId, partnerId: q.partnerId, period: q.period, deductions: q.deductions ?? undefined });
  }

  async settlement(actor: Actor, id: Id) {
    return mustOwn(await this.repos.settlements.get(id), actor.orgId, "Settlement", id);
  }

  settlements(actor: Actor, q: { partnerId?: Id | null; status?: SettlementStatus | null; branchIds: "all" | Id[]; limit: number; offset: number }) {
    const filter = clean({ orgId: actor.orgId, partnerId: q.partnerId, status: q.status }) as never;
    return this.repos.settlements.find(filter, { limit: q.limit + q.offset, sort: { field: "createdAt", dir: "desc" } }).then((all) =>
      (q.branchIds === "all" ? all : all.filter((s) => (q.branchIds as Id[]).includes(s.branchId))).slice(q.offset, q.offset + q.limit),
    );
  }

  create(actor: Actor, q: { partnerId: Id; period: string; deductions?: SettlementDeduction[] | null }) {
    return createSettlement(this.repos, { orgId: actor.orgId, partnerId: q.partnerId, period: q.period, deductions: q.deductions ?? undefined }, actor.userId);
  }

  accrue(actor: Actor, settlementId: Id) {
    return accrueSettlement(this.repos, { orgId: actor.orgId, settlementId }, actor.userId);
  }

  pay(actor: Actor, q: { settlementId: Id; mode: PaymentMode; date?: Date | null; reference?: string | null }) {
    return paySettlement(this.repos, { orgId: actor.orgId, settlementId: q.settlementId, mode: q.mode, date: q.date ?? undefined, reference: q.reference ?? undefined }, actor.userId);
  }

  cancel(actor: Actor, settlementId: Id) {
    return cancelSettlement(this.repos, { orgId: actor.orgId, settlementId }, actor.userId);
  }
}
