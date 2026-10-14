import { registerPatient, type Address, type Doctor, type Id, type Patient, type Repositories, type Sex } from "@mgpl-diagnostics/db-kit";
import type { Actor } from "../graphql/context";
import { clean, mustOwn, owned } from "./util";

export interface RegisterPatientInput {
  branchId: Id;
  title?: string | null;
  name: string;
  sex: Sex;
  dob?: Date | null;
  ageYears?: number | null;
  phone?: string | null;
  email?: string | null;
  address?: Address | null;
}

export interface DoctorInput {
  name: string;
  qualification?: string | null;
  phone?: string | null;
  clinic?: string | null;
  active?: boolean | null;
}

/** Patients (UHID per organisation) and referring doctors. */
export class PatientService {
  constructor(private readonly repos: Repositories) {}

  async get(actor: Actor, id: Id): Promise<Patient | null> {
    return owned(await this.repos.patients.get(id), actor.orgId);
  }

  search(actor: Actor, text: string, limit: number) {
    return this.repos.patients.search(actor.orgId, text, limit);
  }

  async register(actor: Actor, input: RegisterPatientInput) {
    mustOwn(await this.repos.branches.get(input.branchId), actor.orgId, "Branch", input.branchId);
    return registerPatient(this.repos, { ...(clean(input) as RegisterPatientInput), orgId: actor.orgId } as never, actor.userId);
  }

  async update(actor: Actor, id: Id, patch: Partial<Omit<RegisterPatientInput, "branchId">>) {
    mustOwn(await this.repos.patients.get(id), actor.orgId, "Patient", id);
    const p = await this.repos.patients.update(id, clean(patch) as never);
    await this.repos.audit.log({ orgId: actor.orgId, userId: actor.userId, action: "patient.update", entity: "patient", entityId: id });
    return p!;
  }

  doctors(actor: Actor, activeOnly: boolean): Promise<Doctor[]> {
    return this.repos.doctors.find(activeOnly ? { orgId: actor.orgId, active: true } : { orgId: actor.orgId }, { sort: { field: "name" } });
  }

  async createDoctor(actor: Actor, input: DoctorInput) {
    return this.repos.doctors.create({ ...(clean(input) as DoctorInput), orgId: actor.orgId, active: input.active ?? true } as never);
  }

  async updateDoctor(actor: Actor, id: Id, patch: Partial<DoctorInput>) {
    mustOwn(await this.repos.doctors.get(id), actor.orgId, "Doctor", id);
    return (await this.repos.doctors.update(id, clean(patch) as never))!;
  }
}
