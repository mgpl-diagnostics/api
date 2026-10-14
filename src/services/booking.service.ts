import { getTestByCode } from "@mgpl-diagnostics/catalog-kit";
import { ConflictError, createBooking, ValidationError, type BookingStatus, type BookingTest, type CollectionType, type Id, type Repositories, type Sample } from "@mgpl-diagnostics/db-kit";
import type { Actor } from "../graphql/context";
import { clean, mustOwn, owned, scopedFind } from "./util";

export interface BookingTestInput {
  testCode: string;
  name?: string | null;
  pricePaise?: number | null;
  sampleType?: string | null;
}

export interface CreateBookingInput {
  branchId: Id;
  patientId: Id;
  doctorId?: Id | null;
  tests: BookingTestInput[];
  collectionType?: CollectionType | null;
  scheduledAt?: Date | null;
  notes?: string | null;
}

/**
 * A test line from catalog-kit when only the code is given: name, price (MRP, rupees → paise) and
 * sample type come from the catalog; anything sent explicitly wins.
 */
export function bookingTest(t: BookingTestInput): BookingTest {
  const cat = getTestByCode(t.testCode);
  const name = t.name ?? cat?.name;
  const pricePaise = t.pricePaise ?? (cat?.mrp != null ? cat.mrp * 100 : undefined);
  if (!name || pricePaise == null) throw new ValidationError(`Test ${t.testCode} is not in the catalog; send its name and pricePaise`);
  if (!Number.isInteger(pricePaise) || pricePaise < 0) throw new ValidationError(`Test ${t.testCode}: pricePaise must be a whole number >= 0`);
  return clean({ testCode: t.testCode, name, pricePaise, sampleType: t.sampleType ?? cat?.sampleType ?? undefined }) as BookingTest;
}

/** Bookings and their samples (barcodes). */
export class BookingService {
  constructor(private readonly repos: Repositories) {}

  async get(actor: Actor, id: Id) {
    return mustOwn(await this.repos.bookings.get(id), actor.orgId, "Booking", id);
  }

  list(actor: Actor, q: { scope: "all" | Id[]; status?: BookingStatus | null; patientId?: Id | null; limit: number; offset: number }) {
    return scopedFind(this.repos.bookings, clean({ orgId: actor.orgId, status: q.status, patientId: q.patientId }), q.scope, q.limit, q.offset, "createdAt");
  }

  async create(actor: Actor, input: CreateBookingInput) {
    mustOwn(await this.repos.branches.get(input.branchId), actor.orgId, "Branch", input.branchId);
    mustOwn(await this.repos.patients.get(input.patientId), actor.orgId, "Patient", input.patientId);
    if (input.doctorId) mustOwn(await this.repos.doctors.get(input.doctorId), actor.orgId, "Doctor", input.doctorId);
    return createBooking(this.repos, {
      orgId: actor.orgId,
      branchId: input.branchId,
      patientId: input.patientId,
      doctorId: input.doctorId ?? null,
      tests: input.tests.map(bookingTest),
      sampleCollection: { type: input.collectionType ?? "walk_in", scheduledAt: input.scheduledAt ?? null },
      notes: input.notes ?? undefined,
    }, actor.userId);
  }

  async cancel(actor: Actor, id: Id) {
    const b = await this.get(actor, id);
    if (b.status === "cancelled") return b;
    if (b.invoiceId) {
      const inv = await this.repos.invoices.get(b.invoiceId);
      if (inv && inv.status !== "cancelled") throw new ConflictError("Cancel the booking's invoice first");
    }
    const out = await this.repos.bookings.update(id, { status: "cancelled" });
    await this.repos.audit.log({ orgId: b.orgId, branchId: b.branchId, userId: actor.userId, action: "booking.cancel", entity: "booking", entityId: id });
    return out!;
  }

  // ---------------------------------------------------------------- samples

  samplesOf(bookingId: Id) {
    return this.repos.samples.find({ bookingId }, { sort: { field: "barcode" } });
  }

  async sample(actor: Actor, id: Id) {
    return mustOwn(await this.repos.samples.get(id), actor.orgId, "Sample", id);
  }

  async sampleByBarcode(actor: Actor, barcode: string) {
    return owned(await this.repos.samples.findOne({ orgId: actor.orgId, barcode: barcode.trim() }), actor.orgId);
  }

  async collectSample(actor: Actor, s: Sample) {
    if (s.status !== "pending") throw new ConflictError(`Sample is ${s.status}`);
    const out = await this.repos.samples.update(s.id, { status: "collected", collectedAt: new Date(), collectedBy: actor.userId });
    const b = await this.repos.bookings.get(s.bookingId);
    if (b?.status === "booked") await this.repos.bookings.update(b.id, { status: "sample_collected" });
    await this.repos.audit.log({ orgId: s.orgId, branchId: s.branchId, userId: actor.userId, action: "sample.collect", entity: "sample", entityId: s.id });
    return out!;
  }

  async receiveSample(actor: Actor, s: Sample) {
    if (s.status !== "collected") throw new ConflictError(`Sample is ${s.status}`);
    const out = await this.repos.samples.update(s.id, { status: "received", receivedAt: new Date() });
    await this.repos.bookings.update(s.bookingId, { status: "in_process" });
    await this.repos.audit.log({ orgId: s.orgId, branchId: s.branchId, userId: actor.userId, action: "sample.receive", entity: "sample", entityId: s.id });
    return out!;
  }

  async rejectSample(actor: Actor, s: Sample, reason: string) {
    if (s.status === "rejected") throw new ConflictError("Sample is already rejected");
    if (!reason.trim()) throw new ValidationError("Give a reason");
    const out = await this.repos.samples.update(s.id, { status: "rejected", rejectReason: reason.trim() });
    await this.repos.audit.log({ orgId: s.orgId, branchId: s.branchId, userId: actor.userId, action: "sample.reject", entity: "sample", entityId: s.id });
    return out!;
  }
}
