import { ConflictError, NotFoundError, ValidationError, type Address, type Branch, type BranchKind, type Id, type Repositories } from "@mgpl-diagnostics/db-kit";
import { isValidGstin } from "@mgpl-diagnostics/finance-kit";
import type { Actor } from "../graphql/context";
import { clean, mustOwn } from "./util";

export interface BranchInput {
  code: string;
  name: string;
  kind: BranchKind;
  phone?: string | null;
  gstin?: string | null;
  stateCode?: string | null;
  address?: Address | null;
  active?: boolean | null;
}

export interface OrganizationPatch {
  name?: string | null;
  legalName?: string | null;
  gstin?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: Address | null;
}

const checkGstin = (g?: string | null) => {
  if (g && !isValidGstin(g)) throw new ValidationError(`Invalid GSTIN ${g}`);
};

/** The signed-in user's organisation and its branches. */
export class OrganizationService {
  constructor(private readonly repos: Repositories) {}

  async organization(actor: Actor) {
    const org = await this.repos.orgs.get(actor.orgId);
    if (!org) throw new NotFoundError("Organization", actor.orgId);
    return org;
  }

  async updateOrganization(actor: Actor, patch: OrganizationPatch) {
    checkGstin(patch.gstin);
    const org = await this.repos.orgs.update(actor.orgId, clean(patch) as never);
    await this.repos.audit.log({ orgId: actor.orgId, userId: actor.userId, action: "org.update", entity: "organization", entityId: actor.orgId });
    return org!;
  }

  branches(actor: Actor): Promise<Branch[]> {
    return this.repos.branches.find({ orgId: actor.orgId }, { sort: { field: "code" } });
  }

  async branch(actor: Actor, id: Id) {
    return mustOwn(await this.repos.branches.get(id), actor.orgId, "Branch", id);
  }

  async createBranch(actor: Actor, input: BranchInput) {
    checkGstin(input.gstin);
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(code)) throw new ValidationError("Branch code: 2-12 letters or digits");
    if (await this.repos.branches.findOne({ orgId: actor.orgId, code })) throw new ConflictError(`Branch ${code} already exists`);
    const b = await this.repos.branches.create({ ...(clean(input) as BranchInput), orgId: actor.orgId, code, active: input.active ?? true } as never);
    await this.repos.audit.log({ orgId: actor.orgId, branchId: b.id, userId: actor.userId, action: "branch.create", entity: "branch", entityId: b.id });
    return b as Branch;
  }

  async updateBranch(actor: Actor, id: Id, patch: Partial<Omit<BranchInput, "code">>) {
    mustOwn(await this.repos.branches.get(id), actor.orgId, "Branch", id);
    checkGstin(patch.gstin);
    const b = await this.repos.branches.update(id, clean(patch) as never);
    await this.repos.audit.log({ orgId: actor.orgId, branchId: id, userId: actor.userId, action: "branch.update", entity: "branch", entityId: id });
    return b!;
  }

  /** Audit trail, newest first. */
  audit(actor: Actor, q: { entity?: string | null; entityId?: Id | null; limit: number; offset: number }) {
    return this.repos.audit.find(clean({ orgId: actor.orgId, entity: q.entity, entityId: q.entityId }) as never, { limit: q.limit, offset: q.offset, sort: { field: "at", dir: "desc" } });
  }
}
