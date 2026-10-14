import { getTestByCode } from "@mgpl-diagnostics/catalog-kit";
import type { Booking, BookingStatus, BookingTest, Patient, Report, ResultValue, Sample } from "@mgpl-diagnostics/db-kit";
import type { RequestContext as Ctx } from "../graphql/context";
import { withErrorCodes } from "../graphql/errors";
import { actorOf, authorize, branchScope, canSee, cap } from "../graphql/guards";
import type { CreateBookingInput } from "../services/booking.service";
import type { DoctorInput, RegisterPatientInput } from "../services/patient.service";
import { scopedFind } from "../services/util";

/** A result flag "" (normal) is NONE in GraphQL. */
export const flagOut = (f: ResultValue["flag"]) => (f === "" ? "NONE" : f ?? null);
export const flagIn = (f?: string | null): ResultValue["flag"] => (f === "NONE" ? "" : ((f ?? undefined) as ResultValue["flag"]));

async function sampleFor(ctx: Ctx, id: string, permission: string) {
  const s = await ctx.services.bookings.sample(actorOf(ctx), id);
  authorize(ctx, permission, s.branchId);
  return s;
}

async function reportFor(ctx: Ctx, id: string, permission: string) {
  const r = await ctx.services.reports.get(actorOf(ctx), id);
  authorize(ctx, permission, r.branchId);
  return r;
}

/** Patients, doctors, bookings, samples, reports. */
export const labController = withErrorCodes({
  Query: {
    patient: async (_: unknown, a: { id: string }, ctx: Ctx) => ctx.services.patients.get(authorize(ctx, "patient:read"), a.id),
    patients: (_: unknown, a: { search: string; limit?: number }, ctx: Ctx) => ctx.services.patients.search(authorize(ctx, "patient:read"), a.search, cap(a.limit, 20)),
    doctors: (_: unknown, a: { activeOnly?: boolean }, ctx: Ctx) => ctx.services.patients.doctors(authorize(ctx, "doctor:read"), a.activeOnly ?? true),

    booking: async (_: unknown, a: { id: string }, ctx: Ctx) => {
      const b = await ctx.services.bookings.get(actorOf(ctx), a.id);
      authorize(ctx, "booking:read", b.branchId);
      return b;
    },
    bookings: (_: unknown, a: { branchId?: string | null; status?: BookingStatus | null; patientId?: string | null; limit?: number; offset?: number }, ctx: Ctx) =>
      ctx.services.bookings.list(actorOf(ctx), { scope: branchScope(ctx, "booking:read", a.branchId), status: a.status, patientId: a.patientId, limit: cap(a.limit, 50), offset: a.offset ?? 0 }),
    sample: (_: unknown, a: { id: string }, ctx: Ctx) => sampleFor(ctx, a.id, "sample:read"),
    sampleByBarcode: async (_: unknown, a: { barcode: string }, ctx: Ctx) => {
      const s = await ctx.services.bookings.sampleByBarcode(actorOf(ctx), a.barcode);
      if (s) authorize(ctx, "sample:read", s.branchId);
      return s;
    },
    report: (_: unknown, a: { id: string }, ctx: Ctx) => reportFor(ctx, a.id, "report:read"),
  },

  Patient: {
    branch: (p: Patient, _: unknown, ctx: Ctx) => ctx.loaders.branch.load(p.branchId),
    bookings: (p: Patient, a: { limit?: number }, ctx: Ctx) =>
      canSee(ctx, "booking:read") ? scopedFind(ctx.repos.bookings, { patientId: p.id }, ctx.branchesFor("booking:read"), cap(a.limit, 20), 0, "createdAt") : [],
    invoices: (p: Patient, a: { limit?: number }, ctx: Ctx) =>
      canSee(ctx, "invoice:read") ? scopedFind(ctx.repos.invoices, { patientId: p.id }, ctx.branchesFor("invoice:read"), cap(a.limit, 20), 0, "createdAt") : [],
  },
  Booking: {
    patient: (b: Booking, _: unknown, ctx: Ctx) => ctx.loaders.patient.load(b.patientId),
    doctor: (b: Booking, _: unknown, ctx: Ctx) => ctx.loaders.doctor.load(b.doctorId),
    branch: (b: Booking, _: unknown, ctx: Ctx) => ctx.loaders.branch.load(b.branchId),
    samples: (b: Booking, _: unknown, ctx: Ctx) => ctx.services.bookings.samplesOf(b.id),
    reports: (b: Booking, _: unknown, ctx: Ctx) => (canSee(ctx, "report:read", b.branchId) ? ctx.services.reports.ofBooking(b.id) : []),
    invoice: (b: Booking, _: unknown, ctx: Ctx) => (canSee(ctx, "invoice:read", b.branchId) ? ctx.loaders.invoice.load(b.invoiceId) : null),
  },
  BookingTest: {
    catalog: (t: BookingTest) => getTestByCode(t.testCode) ?? null,
  },
  Sample: {
    booking: (s: Sample, _: unknown, ctx: Ctx) => ctx.loaders.booking.load(s.bookingId),
  },
  Report: {
    results: (r: Report) => r.results.map((x) => ({ ...x, flag: flagOut(x.flag) })),
    patient: (r: Report, _: unknown, ctx: Ctx) => ctx.loaders.patient.load(r.patientId),
    booking: (r: Report, _: unknown, ctx: Ctx) => ctx.loaders.booking.load(r.bookingId),
  },

  Mutation: {
    registerPatient: (_: unknown, { input }: { input: RegisterPatientInput }, ctx: Ctx) => ctx.services.patients.register(authorize(ctx, "patient:create", input.branchId), input),
    updatePatient: async (_: unknown, a: { id: string; input: Partial<RegisterPatientInput> }, ctx: Ctx) => {
      const actor = authorize(ctx, "patient:update");
      return ctx.services.patients.update(actor, a.id, a.input);
    },
    createDoctor: (_: unknown, { input }: { input: DoctorInput }, ctx: Ctx) => ctx.services.patients.createDoctor(authorize(ctx, "doctor:manage"), input),
    updateDoctor: (_: unknown, a: { id: string; input: Partial<DoctorInput> }, ctx: Ctx) => ctx.services.patients.updateDoctor(authorize(ctx, "doctor:manage"), a.id, a.input),

    createBooking: (_: unknown, { input }: { input: CreateBookingInput }, ctx: Ctx) => ctx.services.bookings.create(authorize(ctx, "booking:create", input.branchId), input),
    cancelBooking: async (_: unknown, a: { id: string }, ctx: Ctx) => {
      const b = await ctx.services.bookings.get(actorOf(ctx), a.id);
      return ctx.services.bookings.cancel(authorize(ctx, "booking:cancel", b.branchId), a.id);
    },
    collectSample: async (_: unknown, a: { id: string }, ctx: Ctx) => ctx.services.bookings.collectSample(actorOf(ctx), await sampleFor(ctx, a.id, "sample:collect")),
    receiveSample: async (_: unknown, a: { id: string }, ctx: Ctx) => ctx.services.bookings.receiveSample(actorOf(ctx), await sampleFor(ctx, a.id, "sample:receive")),
    rejectSample: async (_: unknown, a: { id: string; reason: string }, ctx: Ctx) => ctx.services.bookings.rejectSample(actorOf(ctx), await sampleFor(ctx, a.id, "sample:reject"), a.reason),

    createReport: async (_: unknown, a: { bookingId: string; testCode: string; testName?: string | null }, ctx: Ctx) => {
      const b = await ctx.services.bookings.get(actorOf(ctx), a.bookingId);
      return ctx.services.reports.create(authorize(ctx, "report:enter", b.branchId), b, a.testCode, a.testName);
    },
    saveResults: async (_: unknown, a: { reportId: string; results: (Omit<ResultValue, "flag"> & { flag?: string | null })[] }, ctx: Ctx) => {
      const r = await reportFor(ctx, a.reportId, "report:enter");
      const results = a.results.map((x) => ({ parameter: x.parameter, value: x.value, ...(x.unit != null ? { unit: x.unit } : {}), ...(x.range != null ? { range: x.range } : {}), ...(x.flag != null ? { flag: flagIn(x.flag) } : {}) }));
      return ctx.services.reports.saveResults(actorOf(ctx), r, results);
    },
    verifyReport: async (_: unknown, a: { id: string }, ctx: Ctx) => ctx.services.reports.verify(actorOf(ctx), await reportFor(ctx, a.id, "report:verify")),
    releaseReport: async (_: unknown, a: { id: string }, ctx: Ctx) => ctx.services.reports.release(actorOf(ctx), await reportFor(ctx, a.id, "report:release")),
    amendReport: async (_: unknown, a: { id: string }, ctx: Ctx) => ctx.services.reports.amend(actorOf(ctx), await reportFor(ctx, a.id, "report:amend")),
  },
});
