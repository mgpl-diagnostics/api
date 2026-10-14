import type { Auth } from "@mgpl-diagnostics/auth-kit";
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
import { OrganizationService } from "./organization.service";
import { PatientService } from "./patient.service";
import { PeriodService } from "./period.service";
import { ReceivablesService } from "./receivables.service";
import { ReportService } from "./report.service";
import { SettlementService } from "./settlement.service";

export interface ServiceDeps {
  repos: Repositories;
  auth: Auth;
  mailer?: Mailer;
  resetUrl: string | null;
  lab?: LabProfile;
  samples: boolean;
}

/** Every service, one instance each. Services know nothing about GraphQL; controllers call them. */
export function createServices(d: ServiceDeps) {
  return {
    auth: new AuthService(d.repos, d.auth, { mailer: d.mailer, resetUrl: d.resetUrl }),
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
    documents: new DocumentService(d.repos, { lab: d.lab, samples: d.samples }),
  };
}

export type Services = ReturnType<typeof createServices>;
export type { Mailer };
