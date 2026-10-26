import { supabaseAdmin } from '@/lib/supabase'
import { sendEmail } from '@/lib/email'
import { portalAccessBlockedReason } from '@/lib/partner-access'
import { signInLinkOrigin } from '@/lib/partner-login-issue'
import { buildPartnerGuideEmail, type GuideCandidate } from '@/lib/partner-guide-email'

// SENDING THE PORTAL GUIDE, from the two places that send it.
//
// The completion webhook mails it the moment a partner signs, and
// scripts/send-partner-guide.mts mails it to everyone who signed
// before this existed. One function rather than two copies, for the
// same reason partner-signin-email.ts gives: the copies drift, and the
// drift shows up as two partners receiving materially different mail
// depending on which path happened to fire.
//
// The ORIGIN is read from the environment here and is never a
// parameter a caller could pass in from a request. The guide carries
// no credential, so the instinct is to care less where it points —
// but it prints a link and tells the reader to enter their email
// there and expect a code. An origin taken from a forged header on a
// webhook POST would make Shipo's own onboarding mail into a working
// phishing page, in Shipo's branding, aimed at the people most likely
// to trust it. Pinned in agreement-webhook/guide-wiring.test.ts.

export interface GuideSendCandidate extends GuideCandidate {
  guide_sent_at?: string | null
}

export type GuideSendResult = { sent: boolean; reason?: string }

/**
 * Mail one partner the guide, at most once.
 *
 * Never throws: both callers are best-effort paths where a mail
 * failure must not become a retry. The webhook in particular has
 * already stamped the partner as signed by the time it gets here, and
 * a thrown error would turn a missing guide into a 500 that DocuSign
 * retries against a partner who is already active.
 */
export async function sendPartnerGuide(partner: GuideSendCandidate): Promise<GuideSendResult> {
  if (partner.guide_sent_at) return { sent: false, reason: `already sent ${partner.guide_sent_at}` }

  const origin = signInLinkOrigin()
  if (!origin) {
    return { sent: false, reason: 'no portal origin configured (NEXT_PUBLIC_PARTNER_URL)' }
  }

  // The access gate lives inside the builder, so this is the one check
  // rather than a second opinion about who may be written to.
  const mail = buildPartnerGuideEmail(partner, origin)
  if (!mail) {
    return { sent: false, reason: portalAccessBlockedReason(partner) ?? 'cannot access the portal' }
  }

  if (!partner.email) return { sent: false, reason: 'no email address' }

  const result = await sendEmail({
    to: partner.email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    // The footer invites a reply; From is a shared env var defaulting
    // to security@. Without this the message contradicts itself.
    replyTo: 'Support@shipousa.com',
  })

  if (!result.sent) return { sent: false, reason: result.error ?? `${result.provider} refused it` }

  // Stamped only after the provider accepted. Stamping first would
  // record a partner as told on a send that never left, and nothing
  // downstream would ever retry it.
  const { error } = await supabaseAdmin
    .from('referral_partners')
    .update({ guide_sent_at: new Date().toISOString() })
    .eq('id', partner.id)

  if (error) {
    // Sent IS true: the mail really went. The reason rides along so the
    // caller can say so loudly, because the next run will send a second
    // copy to a partner who already has one.
    return { sent: true, reason: `sent but not recorded: ${error.message}` }
  }

  return { sent: true }
}
