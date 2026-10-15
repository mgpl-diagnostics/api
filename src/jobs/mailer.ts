import type { Mailer } from "../services/auth.service";

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
