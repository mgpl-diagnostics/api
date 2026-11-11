import type { Auth, RateLimiter } from "@mgpl-diagnostics/auth-kit";
import type { Repositories } from "@mgpl-diagnostics/db-kit";
import type { LabProfile } from "@mgpl-diagnostics/report-kit";
import { AuthService, type Mailer } from "./auth.service";
import { BillingService } from "./billing.service";
import { BookingService } from "./booking.service";
import { BooksService } from "./books.service";
import { CashBankService } from "./cash-bank.service";
import { CatalogService } from "./catalog.service";
import { DocumentService } from "./document.service";
import { ExportService } from "./export.service";
import { GstService } from "./gst.service";
import { ImportService, type ImportLimits } from "./import.service";
import { JobService } from "./job.service";
import type { JobQueue } from "../jobs/types";
import { OrganizationService } from "./organization.service";
import { PatientLinkService, type PatientLinkConfig } from "./patient-link.service";
import { PatientService } from "./patient.service";
import { PeriodService } from "./period.service";
import { ReceivablesService } from "./receivables.service";
import { ReportService } from "./report.service";
import { SettlementService } from "./settlement.service";
import { SystemService } from "./system.service";
import type { Config } from "../config/env";

export interface ServiceDeps {
  repos: Repositories;
  auth: Auth;
  mailer?: Mailer;
  resetUrl: string | null;
  lab?: LabProfile;
  samples: boolean;
  /** The job queue (BullMQ or inline); a getter because the inline queue needs the services first. */
  jobs: () => JobQueue;
  /** Partner-lab PDF limits (IMPORT_* variables). */
  imports: ImportLimits;
  /** Patient links (PATIENT_LINK_*); off when omitted. */
  patientLinks?: PatientLinkConfig;
  /** Limits patient page calls per IP (Redis when REDIS_URL is set, so every replica shares it). */
  patientLinkLimiter?: RateLimiter;
  /** Update notices (UPDATE_* settings); off when omitted. */
  updates?: Config["updates"];
  /** The HTTP client for the release feed (tests). */
  fetch?: typeof fetch;
}

const NO_UPDATES: Config["updates"] = {
  enabled: false, feedUrl: "https://api.github.com", repos: { api: "mgpl-diagnostics/api", dashboard: "mgpl-diagnostics/dashboard" },
  images: { api: "ghcr.io/mgpl-diagnostics/api", dashboard: "ghcr.io/mgpl-diagnostics/dashboard" }, githubToken: null, intervalMs: 6 * 3600_000,
};

/** Every service, one instance each. Services know nothing about GraphQL; controllers call them. */
export function createServices(d: ServiceDeps) {
  const patientLinks = new PatientLinkService(d.repos, d.patientLinks ?? { secret: null, baseUrl: null, ttlDays: 180 }, d.patientLinkLimiter ?? null);
  return {
    auth: new AuthService(d.repos, d.auth, { mailer: d.mailer, resetUrl: d.resetUrl, jobs: d.jobs }),
    organization: new OrganizationService(d.repos),
    catalog: new CatalogService(),
    patients: new PatientService(d.repos),
    bookings: new BookingService(d.repos),
    reports: new ReportService(d.repos),
    billing: new BillingService(d.repos),
    books: new BooksService(d.repos),
    gst: new GstService(d.repos),
    receivables: new ReceivablesService(d.repos),
    settlements: new SettlementService(d.repos),
    cashBank: new CashBankService(d.repos),
    periods: new PeriodService(d.repos),
    exports: new ExportService(d.repos),
    documents: new DocumentService(d.repos, { lab: d.lab, samples: d.samples, links: patientLinks }),
    patientLinks,
    jobs: new JobService(d.repos, d.jobs),
    imports: new ImportService(d.repos, d.jobs, d.imports),
    system: new SystemService(d.updates ?? NO_UPDATES, d.fetch),
  };
}

export type Services = ReturnType<typeof createServices>;
export type { Mailer };
