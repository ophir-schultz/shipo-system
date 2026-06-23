import nodemailer from 'nodemailer'

export interface SendEmailOptions {
  to: string
  subject: string
  html: string
  text?: string
}

/**
 * Provider-agnostic email sender.
 * Auto-selects a provider based on which env vars are configured, in this order:
 *   1. Resend        — RESEND_API_KEY
 *   2. SendGrid      — SENDGRID_API_KEY
 *   3. Gmail / SMTP  — SMTP_HOST + SMTP_USER + SMTP_PASS  (Gmail: smtp.gmail.com + app password)
 *   4. Supabase SMTP — SUPABASE_SMTP_HOST + SUPABASE_SMTP_USER + SUPABASE_SMTP_PASS
 *
 * The "from" address comes from EMAIL_FROM (falls back to a sensible default).
 * Returns { sent, provider, error } — never throws, so a mail failure can't break login.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<{ sent: boolean; provider: string; error?: string }> {
  const from = process.env.EMAIL_FROM || 'Shipo Security <security@shipousa.com>'

  try {
    // 1. Resend (HTTP API, no dependency)
    if (process.env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: opts.to,
          subject: opts.subject,
          html: opts.html,
          text: opts.text,
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return { sent: false, provider: 'resend', error: `Resend ${res.status}: ${body}` }
      }
      return { sent: true, provider: 'resend' }
    }

    // 2. SendGrid (HTTP API, no dependency)
    if (process.env.SENDGRID_API_KEY) {
      const fromEmail = from.match(/<(.+)>/)?.[1] ?? from
      const fromName = from.replace(/<.+>/, '').trim() || undefined
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: opts.to }] }],
          from: { email: fromEmail, name: fromName },
          subject: opts.subject,
          content: [
            ...(opts.text ? [{ type: 'text/plain', value: opts.text }] : []),
            { type: 'text/html', value: opts.html },
          ],
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return { sent: false, provider: 'sendgrid', error: `SendGrid ${res.status}: ${body}` }
      }
      return { sent: true, provider: 'sendgrid' }
    }

    // 3. Gmail / generic SMTP (nodemailer)
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: Number(process.env.SMTP_PORT ?? 587) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      })
      await transport.sendMail({ from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text })
      return { sent: true, provider: 'smtp' }
    }

    // 4. Supabase SMTP (nodemailer)
    if (process.env.SUPABASE_SMTP_HOST && process.env.SUPABASE_SMTP_USER && process.env.SUPABASE_SMTP_PASS) {
      const transport = nodemailer.createTransport({
        host: process.env.SUPABASE_SMTP_HOST,
        port: Number(process.env.SUPABASE_SMTP_PORT ?? 587),
        secure: Number(process.env.SUPABASE_SMTP_PORT ?? 587) === 465,
        auth: { user: process.env.SUPABASE_SMTP_USER, pass: process.env.SUPABASE_SMTP_PASS },
      })
      await transport.sendMail({ from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text })
      return { sent: true, provider: 'supabase-smtp' }
    }

    return { sent: false, provider: 'none', error: 'No email provider configured' }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown email error'
    return { sent: false, provider: 'error', error: msg }
  }
}
