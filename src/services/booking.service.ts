import { getTestByCode } from "@mgpl-diagnostics/catalog-kit";
import {
  cancelInvoice, ConflictError, counterKeys, createBooking, dayKey, formatSampleBarcode, issueInvoice, ValidationError,
  type Address, type Booking, type BookingStatus, type BookingTest, type CollectionType, type CreditNote, type Id, type Invoice, type ItemInput, type Repositories, type Sample,
} from "@mgpl-diagnostics/db-kit";
import { applyTaxRules, issueCreditNote } from "@mgpl-diagnostics/finance-kit";
import type { Actor } from "../graphql/context";
import { invoiceItem, type PaymentInput } from "./billing.service";
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
  /** Bill the booking at once: an invoice for its tests, in the same transaction (needs invoice:create). */
  bill?: BookingBillInput | null;
}

export interface BookingBillInput {
  billDiscountPaise?: number | null;
  payments?: PaymentInput[] | null;
  applyTaxRules?: boolean | null;
}

/** Changes to a booking. Fields left out stay as they are; doctorId: null removes the doctor. */
export interface UpdateBookingInput {
  doctorId?: Id | null;
  collectionType?: CollectionType | null;
  scheduledAt?: Date | null;
  collectionAddress?: Address | null;
  notes?: string | null;
  addTests?: BookingTestInput[] | null;
  removeTestCodes?: string[] | null;
}

export interface UpdateBookingResult {
  booking: Booking;
  samples: Sample[];
  /** Invoices issued by this change (a replacement, or one for the added tests). */
  issued: Invoice[];
  /** Invoices cancelled by this change (unpaid ones, replaced or no longer needed). */
  cancelled: Invoice[];
  /** Credit notes for removed tests on invoices that were paid or already credited. */
  creditNotes: CreditNote[];
  /** Paid money the patient can now be refunded (Refund on the invoice). */
  refundablePaise: number;
}

/**
 * What an edit does to billing, so the caller can check permissions before anything changes:
 * removing a billed test cancels/replaces an unpaid invoice (invoice:cancel) or credits a paid one
 * (accounts:post); adding tests to a billed booking issues an invoice (invoice:create).
 */
export interface BillingImpact { cancels: boolean; credits: boolean; issues: boolean }

/** An invoice line for a booked test. */
export const testItem = (t: BookingTest): ItemInput => invoiceItem({ code: t.testCode, name: t.name, ratePaise: t.pricePaise, category: "test" });

const itemInput = (i: Invoice["items"][number]): ItemInput =>
  clean({ code: i.code, name: i.name, category: i.category, qty: i.qty, ratePaise: i.ratePaise, discountPaise: i.discountPaise, taxPercent: i.taxPercent, hsnSac: i.hsnSac, taxability: i.taxability }) as ItemInput;

/** The bill discount an invoice carried (its total discount less the line discounts). */
const billDiscountOf = (inv: Invoice) => Math.max(0, inv.discountPaise - inv.items.reduce((s, x) => s + (x.discountPaise ?? 0), 0));

const EDITABLE: BookingStatus[] = ["booked", "sample_collected", "in_process"];

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

/** The sample barcode is already used by another sample of this organisation (BARCODE_TAKEN). */
export class BarcodeTakenError extends ConflictError {
  constructor(readonly barcode: string) {
    super(`Barcode ${barcode} is already on another sample`);
    this.name = "BarcodeTakenError";
  }
}

/** A tube label: 3-32 letters, digits, - _ / . (what pre-printed labels and scanners produce). */
export const BARCODE = /^[A-Za-z0-9][A-Za-z0-9\-_/.]{2,31}$/;

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
    const tests = input.tests.map(bookingTest);
    const bill = input.bill;
    if (!bill) return { ...(await this.book(this.repos, actor, input, tests)), invoice: null };
    // the invoice is worked out before anything is written, so a bad discount or payment fails the whole request
    let items = tests.map(testItem);
    if (bill.applyTaxRules) items = await applyTaxRules(this.repos, actor.orgId, items);
    return this.repos.transaction(async (tx) => {
      const made = await this.book(tx, actor, input, tests);
      const { invoice } = await issueInvoice(tx, {
        orgId: actor.orgId, branchId: input.branchId, patientId: input.patientId, bookingId: made.booking.id,
        items, billDiscountPaise: bill.billDiscountPaise ?? 0,
        payments: bill.payments?.map((p) => clean({ amountPaise: p.amountPaise, mode: p.mode, reference: p.reference }) as never),
      }, actor.userId);
      return { booking: { ...made.booking, invoiceId: invoice.id }, samples: made.samples, invoice };
    });
  }

  private book(repos: Repositories, actor: Actor, input: CreateBookingInput, tests: BookingTest[]) {
    return createBooking(repos, {
      orgId: actor.orgId,
      branchId: input.branchId,
      patientId: input.patientId,
      doctorId: input.doctorId ?? null,
      tests,
      sampleCollection: { type: input.collectionType ?? "walk_in", scheduledAt: input.scheduledAt ?? null },
      notes: input.notes ?? undefined,
    }, actor.userId);
  }

  async cancel(actor: Actor, id: Id) {
    const b = await this.get(actor, id);
    if (b.status === "cancelled") return b;
    if ((await this.invoicesOf(b)).some((i) => i.status !== "cancelled")) throw new ConflictError("Cancel the booking's invoice first");
    const out = await this.repos.bookings.update(id, { status: "cancelled" });
    await this.repos.audit.log({ orgId: b.orgId, branchId: b.branchId, userId: actor.userId, action: "booking.cancel", entity: "booking", entityId: id });
    return out!;
  }


  /** Every invoice issued for the booking (its first one, and any for tests added later), oldest first. */
  async invoicesOf(b: Pick<Booking, "id" | "orgId" | "invoiceId">, repos: Repositories = this.repos): Promise<Invoice[]> {
    const found = await repos.invoices.find({ orgId: b.orgId, bookingId: b.id }, { sort: { field: "createdAt", dir: "asc" } });
    if (b.invoiceId && !found.some((i) => i.id === b.invoiceId)) {
      const inv = await repos.invoices.get(b.invoiceId);
      if (inv) found.unshift(inv);
    }
    return found;
  }

  /** Checks an edit and says what it would do to billing (nothing is written). */
  async impact(actor: Actor, b: Booking, input: UpdateBookingInput): Promise<BillingImpact> {
    const { added, removed } = this.checkEdit(b, input);
    const live = (await this.invoicesOf(b)).filter((i) => i.status !== "cancelled");
    const billed = (code: string) => live.find((i) => i.items.some((x) => x.code === code));
    const touched = new Set(removed.map((t) => billed(t.testCode)).filter((i): i is Invoice => !!i));
    let cancels = false;
    let credits = false;
    for (const inv of touched) if (await this.replaceable(inv)) cancels = true; else credits = true;
    return { cancels, credits, issues: added.length > 0 && live.length > 0 };
  }

  /** An invoice can be cancelled and issued again only while nothing was paid or credited on it. */
  private async replaceable(inv: Invoice, repos: Repositories = this.repos) {
    if (inv.paidPaise > 0 || inv.creditedPaise > 0) return false;
    return (await repos.creditNotes.find({ invoiceId: inv.id, status: "issued" })).length === 0;
  }

  private checkEdit(b: Booking, input: UpdateBookingInput) {
    if (!EDITABLE.includes(b.status)) throw new ConflictError(`Booking ${b.bookingNo} is ${b.status.replace("_", " ")}: it can no longer change`);
    const removeCodes = [...new Set((input.removeTestCodes ?? []).map((c) => c.trim()))];
    for (const c of removeCodes) if (!b.tests.some((t) => t.testCode === c)) throw new ValidationError(`Test ${c} is not on booking ${b.bookingNo}`);
    const added = (input.addTests ?? []).map(bookingTest);
    const codes = new Set(b.tests.filter((t) => !removeCodes.includes(t.testCode)).map((t) => t.testCode));
    for (const t of added) {
      if (codes.has(t.testCode)) throw new ValidationError(`Test ${t.testCode} is already on the booking`);
      codes.add(t.testCode);
    }
    if (!codes.size) throw new ValidationError("A booking needs at least one test; cancel it instead");
    const removed = b.tests.filter((t) => removeCodes.includes(t.testCode));
    return { added, removed };
  }

  /**
   * Changes the doctor, the collection details or the notes, adds tests and removes tests that have no
   * results yet. Samples follow the sample types (new tubes for new types; tubes not collected yet are
   * dropped when no test needs them). Billing follows the tests: an unpaid invoice is cancelled and issued
   * again; a paid one gets a credit note for removed tests, and added tests get an invoice of their own.
   * One transaction; audited as booking.update.
   */
  async update(actor: Actor, b: Booking, input: UpdateBookingInput): Promise<UpdateBookingResult> {
    const { added, removed } = this.checkEdit(b, input);
    if (input.doctorId) mustOwn(await this.repos.doctors.get(input.doctorId), actor.orgId, "Doctor", input.doctorId);
    const removedCodes = removed.map((t) => t.testCode);
    const reports = (await this.repos.reports.find({ bookingId: b.id })).filter((r) => removedCodes.includes(r.testCode));
    const started = reports.find((r) => r.status !== "draft" || r.results.length > 0);
    if (started) throw new ConflictError(`${started.testName} already has results: it can't be removed from the booking`);
    const tests = [...b.tests.filter((t) => !removedCodes.includes(t.testCode)), ...added];
    // tax rules for added lines, worked out before writing (missing rules fail the request, not half of it)
    const addedItems = added.map(testItem);

    return this.repos.transaction(async (tx) => {
      const patch: Partial<Booking> = {};
      const changes: Record<string, unknown> = {};
      if (input.doctorId !== undefined && (input.doctorId ?? null) !== (b.doctorId ?? null)) {
        patch.doctorId = input.doctorId ?? null;
        changes.doctor = { from: b.doctorId ?? null, to: patch.doctorId };
      }
      if (input.collectionType != null || input.scheduledAt !== undefined || input.collectionAddress !== undefined) {
        const sc = { ...b.sampleCollection };
        if (input.collectionType != null) sc.type = input.collectionType;
        if (input.scheduledAt !== undefined) sc.scheduledAt = input.scheduledAt ?? null;
        if (input.collectionAddress !== undefined) {
          if (input.collectionAddress) sc.address = clean(input.collectionAddress) as Address;
          else delete sc.address;
        }
        patch.sampleCollection = sc;
        changes.collection = true;
      }
      if (input.notes !== undefined) {
        patch.notes = input.notes?.trim() || undefined;
        changes.notes = true;
      }
      if (added.length || removed.length) {
        patch.tests = tests;
        changes.added = added.map((t) => t.testCode);
        changes.removed = removedCodes;
      }

      // reports opened for removed tests hold no results (checked above): drop them
      for (const r of reports) await tx.reports.delete(r.id);

      // samples: one tube per sample type still needed
      const samples = await tx.samples.find({ bookingId: b.id });
      const types = new Set(tests.map((t) => t.sampleType ?? "OTHER"));
      for (const s of samples) if (!types.has(s.sampleType) && s.status === "pending") await tx.samples.delete(s.id);
      const now = new Date();
      for (const type of types) {
        if (samples.some((s) => s.sampleType === type && s.status !== "rejected")) continue;
        const n = await tx.counters.next(counterKeys.sample(b.orgId));
        await tx.samples.create({
          orgId: b.orgId, branchId: b.branchId, bookingId: b.id, sampleType: type, status: "pending",
          barcode: formatSampleBarcode(dayKey(now).slice(0, 2), n), collectedAt: null, collectedBy: null, receivedAt: null, rejectReason: null,
        } as never);
      }

      // billing
      const result = { issued: [] as Invoice[], cancelled: [] as Invoice[], creditNotes: [] as CreditNote[], refundablePaise: 0 };
      const live = (await this.invoicesOf(b, tx)).filter((i) => i.status !== "cancelled");
      let primary = live.find((i) => i.id === b.invoiceId) ?? live[0] ?? null;
      let toAdd = addedItems;
      if (live.length) {
        const usesTaxRules = live.some((i) => i.items.some((x) => x.taxability));
        if (usesTaxRules && toAdd.length) toAdd = await applyTaxRules(tx, b.orgId, toAdd);
        const reason = `Booking ${b.bookingNo} changed${removedCodes.length ? `: removed ${removed.map((t) => t.name).join(", ")}` : ""}`;
        for (const inv of live) {
          const gone = inv.items.map((x, i) => ({ x, i })).filter(({ x }) => x.code && removedCodes.includes(x.code));
          const extra = inv.id === primary?.id ? toAdd : [];
          if (!gone.length && !extra.length) continue;
          if (await this.replaceable(inv, tx)) {
            const keep = inv.items.filter((x) => !(x.code && removedCodes.includes(x.code))).map(itemInput);
            const items = [...keep, ...extra];
            await cancelInvoice(tx, inv.id, reason, actor.userId);
            result.cancelled.push({ ...inv, status: "cancelled" });
            if (inv.id === primary?.id) toAdd = [];
            if (!items.length) {
              if (inv.id === primary?.id) primary = null;
              continue;
            }
            const subtotal = items.reduce((s, x) => s + Math.max(0, Math.round((x.qty ?? 1) * x.ratePaise) - (x.discountPaise ?? 0)), 0);
            const { invoice } = await issueInvoice(tx, {
              orgId: inv.orgId, branchId: inv.branchId, patientId: inv.patientId, bookingId: b.id,
              customerId: inv.customerId ?? null, placeOfSupply: inv.placeOfSupply ?? null, buyerGstin: inv.buyerGstin ?? null,
              items, billDiscountPaise: Math.min(billDiscountOf(inv), subtotal),
            }, actor.userId);
            result.issued.push(invoice);
            if (inv.id === primary?.id) primary = invoice;
          } else if (gone.length) {
            const r = await issueCreditNote(tx, { orgId: b.orgId, invoiceId: inv.id, reason, lines: gone.map(({ i }) => ({ itemIndex: i })) }, actor.userId);
            result.creditNotes.push(r.creditNote);
            result.refundablePaise += r.refundablePaise;
          }
        }
        if (toAdd.length) {
          // the first invoice was paid or credited: the added tests get an invoice of their own
          const base = primary ?? live[0]!;
          const { invoice } = await issueInvoice(tx, {
            orgId: base.orgId, branchId: base.branchId, patientId: base.patientId, bookingId: b.id,
            customerId: base.customerId ?? null, placeOfSupply: base.placeOfSupply ?? null, buyerGstin: base.buyerGstin ?? null, items: toAdd,
          }, actor.userId);
          result.issued.push(invoice);
          primary ??= invoice;
        }
      }
      // issueInvoice/cancelInvoice point the booking at the invoice they touched; keep it on the first live one
      patch.invoiceId = primary?.id ?? null;

      const booking = (await tx.bookings.update(b.id, patch))!;
      await tx.audit.log({ orgId: b.orgId, branchId: b.branchId, userId: actor.userId, action: "booking.update", entity: "booking", entityId: b.id, data: changes });
      return { booking, samples: await tx.samples.find({ bookingId: b.id }, { sort: { field: "barcode" } }), ...result };
    });
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

  /**
   * A new barcode for a sample, e.g. the pre-printed label on the tube the branch has. Unique within the
   * organisation (the database enforces it too); allowed until the lab receives the sample.
   */
  private async checkBarcode(s: Sample, raw: string): Promise<string> {
    const barcode = raw.trim();
    if (!BARCODE.test(barcode)) throw new ValidationError("A barcode is 3-32 letters, digits or - _ / .");
    const other = await this.repos.samples.findOne({ orgId: s.orgId, barcode });
    if (other && other.id !== s.id) throw new BarcodeTakenError(barcode);
    return barcode;
  }

  private async updateBarcode(s: Sample, patch: Partial<Sample>) {
    try {
      return await this.repos.samples.update(s.id, patch);
    } catch (e) {
      // two people saving the same new barcode at once: the unique index decides
      if (patch.barcode && /unique|duplicate|E11000/i.test(String((e as Error)?.message ?? e))) throw new BarcodeTakenError(patch.barcode);
      throw e;
    }
  }

  async relabelSample(actor: Actor, s: Sample, raw: string) {
    if (s.status !== "pending" && s.status !== "collected") throw new ConflictError(`Sample is ${s.status}: its barcode can no longer change`);
    const barcode = await this.checkBarcode(s, raw);
    if (barcode === s.barcode) return s;
    const out = await this.updateBarcode(s, { barcode });
    await this.repos.audit.log({ orgId: s.orgId, branchId: s.branchId, userId: actor.userId, action: "sample.relabel", entity: "sample", entityId: s.id, data: { from: s.barcode, to: barcode } });
    return out!;
  }

  async collectSample(actor: Actor, s: Sample, raw?: string | null) {
    if (s.status !== "pending") throw new ConflictError(`Sample is ${s.status}`);
    const barcode = raw?.trim() ? await this.checkBarcode(s, raw) : s.barcode;
    const out = await this.updateBarcode(s, { status: "collected", collectedAt: new Date(), collectedBy: actor.userId, ...(barcode !== s.barcode ? { barcode } : {}) });
    const b = await this.repos.bookings.get(s.bookingId);
    if (b?.status === "booked") await this.repos.bookings.update(b.id, { status: "sample_collected" });
    await this.repos.audit.log({ orgId: s.orgId, branchId: s.branchId, userId: actor.userId, action: "sample.collect", entity: "sample", entityId: s.id, ...(barcode !== s.barcode ? { data: { from: s.barcode, to: barcode } } : {}) });
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
