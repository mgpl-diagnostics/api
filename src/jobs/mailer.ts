import { createMailer, smtpTransport, type Brand, type Mailer as MailKitMailer } from "@mgpl-diagnostics/mail-kit";
import type { LabProfile } from "@mgpl-diagnostics/report-kit";
import type { Config } from "../config/env";
import type { Mailer } from "../services/auth.service";

/**
 * The Mailer on mail-kit: the "password-reset" mail (our mail design language → HTML + text), sent
 * straight through mail-kit's transport. It runs inside the worker's password-reset job (or in the API
 * without Redis), so the queueing is the api's own and mail-kit is given no queue.
 */
export function mailKitMailer(mail: MailKitMailer): Mailer {
  return {
    async passwordReset(to, link, expiresAt) {
      await mail.send("password-reset", { name: to.name, email: to.email, link, expiresAt: expiresAt.toISOString() }, { to: { name: to.name, email: to.email } });
    },
  };
}

/** The lab as mail-kit's brand (header and footer of every mail). Details come from report-kit's lab profile. */
export function brandFromLab(lab: LabProfile): Brand {
  return {
    name: lab.name,
    ...(lab.addressLines?.length ? { addressLines: lab.addressLines } : {}),
    ...(lab.phone ? { phone: lab.phone } : {}),
    ...(lab.email ? { email: lab.email } : {}),
  };
}

/**
 * A Mailer that POSTs each email as JSON `{ to, subject, text }` to an HTTP relay (MAIL_WEBHOOK_URL):
 * your email provider's API, or a small function in front of it. No SMTP dependency here.
 */
export function webhookMailer(url: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async passwordReset(to, link, expiresAt) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: to.email,
          subject: "Reset your MGPL Diagnostics password",
          text: `Hello ${to.name},\n\nOpen this link to choose a new password:\n${link}\n\nIt works once and expires at ${expiresAt.toISOString()}. If you did not ask for it, ignore this email.`,
        }),
      });
      if (!res.ok) throw new Error(`mail relay answered ${res.status}`);
    },
  };
}

/** The Mailer the configuration asks for: mail-kit over SMTP_URL, else MAIL_WEBHOOK_URL, else none. */
export function mailerFromConfig(config: Config, lab: LabProfile): Mailer | undefined {
  if (config.smtp) {
    return mailKitMailer(createMailer({ transport: smtpTransport(config.smtp.url), from: config.smtp.from, brand: brandFromLab(lab) }));
  }
  return config.mailWebhookUrl ? webhookMailer(config.mailWebhookUrl) : undefined;
}
