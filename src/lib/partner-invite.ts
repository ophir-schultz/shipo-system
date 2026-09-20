import { sendEmail } from '@/lib/email'

// The portal invite, in one place.
//
// Two callers send this: a staff member clicking "Invite" in the
// Referrals screen, and the DocuSign webhook the moment a partner
// finishes signing. They must produce an identical email — a partner
// who gets a different-looking message depending on which path fired
// has no way to tell the automated one from a phishing attempt.
//
// Nothing here is a credential. The email carries the portal address
// and nothing else; the partner requests their own 6-digit code from
// the login screen. That means this email is safe to re-send, safe to
// forward, and worthless if intercepted.

export interface InvitablePartner {
  name: string | null
  email: string | null
}

export function partnerPortalUrl(origin?: string | null): string {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ??
    origin ??
    'https://shipousa.com'
  return `${base.replace(/\/$/, '')}/partner/login`
}

export async function sendPortalInvite(
  partner: InvitablePartner,
  origin?: string | null,
): Promise<{ sent: boolean; provider: string; error?: string }> {
  if (!partner.email) {
    return { sent: false, provider: 'none', error: 'Partner has no email address.' }
  }

  const loginUrl = partnerPortalUrl(origin)
  const firstName = (partner.name ?? '').split(' ')[0] || 'there'

  return sendEmail({
    to: partner.email,
    subject: 'Your Shipo partner statement is ready',
    text:
      `Hi ${firstName},\n\n` +
      `Your Shipo partner portal is now open. It shows every client you referred, ` +
      `the monthly figures on their account, and exactly what you have earned.\n\n` +
      `Sign in here: ${loginUrl}\n\n` +
      `There is no password. Enter this email address (${partner.email}) and we'll send you ` +
      `a 6-digit code to get in.\n\n` +
      `Questions about any figure? Just reply to this email.\n\n` +
      `Shipo LLC · 310 Cornell Dr, Suite B4, Wilmington, DE 19801 · Support@shipousa.com`,
    html:
      `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">` +
      `<p style="margin:0 0 16px">Hi ${firstName},</p>` +
      `<p style="margin:0 0 16px">Your Shipo partner portal is now open. It shows every client you referred, the monthly figures on their account, and exactly what you have earned.</p>` +
      `<p style="margin:0 0 24px"><a href="${loginUrl}" style="display:inline-block;background:#00AAFF;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Open your statement</a></p>` +
      `<p style="margin:0 0 16px;color:#555">There is no password. Enter this email address (<strong>${partner.email}</strong>) and we&rsquo;ll send you a 6-digit code to get in.</p>` +
      `<p style="margin:0 0 24px;color:#555">Questions about any figure? Just reply to this email.</p>` +
      `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">` +
      `<p style="margin:0;font-size:12px;color:#888">Shipo LLC &middot; 310 Cornell Dr, Suite B4, Wilmington, DE 19801 &middot; Support@shipousa.com</p>` +
      `</div>`,
  })
}
